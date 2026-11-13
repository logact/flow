import {
  createLearningTask,
  inspectGeneratedTask,
  knowledgePointName,
} from '../domain/functions';
import type { TaskSpecification } from '../domain/functions';
import type { GeneratedTask, ISODateTime, LearningTask } from '../domain/model';
import { logger as defaultLogger, type AppLogger } from './logger';
import type {
  LearningTaskRepository,
  TaskGenerationAIProvider,
  TaskGenerationAIRequest,
} from './ports';

export interface GenerateLearningTaskUseCaseInput {
  taskId: string;
  learnerId: string;
  specification: TaskSpecification;
  issuedAt: ISODateTime;
}

export type GenerateLearningTaskFailure =
  | 'context_not_found'
  | 'ai_error'
  | 'invalid_ai_output'
  | 'spec_mismatch';

export type GenerateLearningTaskResult =
  | { ok: true; task: LearningTask }
  | { ok: false; reason: GenerateLearningTaskFailure };

/** AI 生成重试上限：解析或校验失败时最多尝试这么多次，之后整体判失败。 */
export const MAX_TASK_GENERATION_ATTEMPTS = 3;

const PARSE_FAILURE_FEEDBACK = '输出无法解析为合法 JSON，请严格只输出一个 JSON 对象，不要使用 markdown 代码块或任何解释文字。';

/**
 * S08：为一个 new 排期位置生成学习任务。
 * AI 生成、解析、校验都成功后只返回暂态 LearningTask，不在本用例持久化；
 * 解析/校验失败带原因重试，最多 MAX_TASK_GENERATION_ATTEMPTS 次，用尽后判失败；
 * AI 请求失败（网络/供应商错误）由 llm 客户端内部重试，这里直接判 ai_error。
 * 任何失败都不创建、不保存任务，交由 S09 一次性应用完整任务集合。
 */
export async function generateLearningTaskUseCase(
  deps: {
    repository: LearningTaskRepository;
    aiProvider: TaskGenerationAIProvider;
    logger?: AppLogger;
  },
  input: GenerateLearningTaskUseCaseInput,
): Promise<GenerateLearningTaskResult> {
  const logger = deps.logger ?? defaultLogger;
  const startedAt = Date.now();
  const { goalId, wordId, task } = input.specification;

  const context = await deps.repository.loadTaskGenerationContext(goalId, wordId);
  if (!context) {
    logger.warn({ goalId, wordId }, '任务生成：目标知识点不存在');
    return { ok: false, reason: 'context_not_found' };
  }
  logger.debug(
    { goalId, wordId, sourceMaterialCount: context.sourceMaterials.length },
    '任务生成：上下文已加载',
  );

  const target = knowledgePointName(context.knowledgePoint);
  const baseRequest: Omit<TaskGenerationAIRequest, 'feedback'> = {
    specification: input.specification,
    knowledgePoint: context.knowledgePoint,
    sourceMaterials: context.sourceMaterials,
    learnerVocabulary: context.learnerVocabulary,
  };

  let feedback: string | undefined;
  let lastReason: 'invalid_ai_output' | 'spec_mismatch' = 'invalid_ai_output';
  for (let attempt = 1; attempt <= MAX_TASK_GENERATION_ATTEMPTS; attempt++) {
    logger.info({
      taskId: input.taskId,
      learnerId: input.learnerId,
      goalId,
      wordId,
      task,
      attempt,
      maxAttempts: MAX_TASK_GENERATION_ATTEMPTS,
      feedback,
    }, '任务生成：AI 尝试');

    let raw: string;
    try {
      raw = await deps.aiProvider.generateTask({ ...baseRequest, feedback });
    } catch (error) {
      logger.error(
        {
          goalId, wordId, task, attempt,
          error: error instanceof Error ? error.message : String(error),
        },
        '任务生成：AI 请求失败',
      );
      return { ok: false, reason: 'ai_error' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastReason = 'invalid_ai_output';
      feedback = PARSE_FAILURE_FEEDBACK;
      logger.warn(
        { goalId, wordId, task, attempt, snippet: raw.slice(0, 2000) },
        '任务生成：AI 输出无法解析',
      );
      continue;
    }

    const inspection = inspectGeneratedTask(
      input.specification,
      parsed as GeneratedTask,
      target,
    );
    if (inspection.reasons.length > 0) {
      lastReason = inspection.malformed ? 'invalid_ai_output' : 'spec_mismatch';
      feedback = inspection.reasons.join('；');
      logger.warn(
        {
          goalId, wordId, task, attempt,
          malformed: inspection.malformed,
          reasons: inspection.reasons,
          snippet: raw.slice(0, 2000),
        },
        '任务生成：AI 输出未通过校验',
      );
      continue;
    }

    const learningTask = createLearningTask({
      id: input.taskId,
      learnerId: input.learnerId,
      specification: input.specification,
      generated: parsed as GeneratedTask,
      issuedAt: input.issuedAt,
    });
    logger.info({
      taskId: input.taskId,
      learnerId: input.learnerId,
      goalId,
      wordId,
      task,
      attempt,
      durationMs: Date.now() - startedAt,
      taskContent: learningTask.content,
    }, '任务生成：任务已生成');
    return { ok: true, task: learningTask };
  }

  logger.error({
    taskId: input.taskId,
    learnerId: input.learnerId,
    goalId,
    wordId,
    task,
    attempts: MAX_TASK_GENERATION_ATTEMPTS,
    reason: lastReason,
    feedback,
  }, '任务生成：AI 尝试次数用尽');
  return { ok: false, reason: lastReason };
}
