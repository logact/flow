import * as Domain from '../domain/functions';
import type {
  DimensionJudgement,
  ISODateTime,
  LearningState,
  LearningTask,
  TaskAttempt,
  TaskJudgement,
  TaskSettlement,
} from '../domain/model';
import type { SemanticJudgementResult, TaskAIJudge } from './ai-judge';
import { logger as defaultLogger } from './logger';
import type { AppLogger } from './logger';
import { ConcurrencyConflictError } from './repository';
import type { LearningStateRepository } from './repository';

export interface JudgeAndSettleTaskAttemptInput {
  attemptId: string;
  judgedAt: ISODateTime;
  now: ISODateTime;
}

export interface JudgeAndSettleTaskAttemptResult {
  feedback: string | null;
  settlement: TaskSettlement;
}

/**
 * S11：评判并结算学习任务作答。
 * 已结算的作答直接返回已有结果；received 的作答先转入 judging 并保存，
 * 再由规则或 AI 给出评判，最后统一交由 Domain 结算并保存完整状态。
 */
export async function judgeAndSettleTaskAttempt(
  repository: LearningStateRepository,
  aiJudge: TaskAIJudge,
  input: JudgeAndSettleTaskAttemptInput,
  logger: AppLogger = defaultLogger,
): Promise<JudgeAndSettleTaskAttemptResult> {
  const log = bindLogger(logger, { attemptId: input.attemptId });
  assertDateTime(input.judgedAt, 'judgedAt');
  assertDateTime(input.now, 'now');
  const loaded = repository.load();
  const attempt = loaded.state.attempts.find((item) => item.id === input.attemptId);
  if (!attempt) {
    log.warn({}, '未找到作答记录');
    throw new Error(`Attempt not found: ${input.attemptId}`);
  }
  if (attempt.status === 'settled') {
    log.debug({}, '作答已结算，直接返回已有结果');
    return { feedback: attempt.judgement.feedback, settlement: attempt.settlement };
  }
  if (attempt.status !== 'received' && attempt.status !== 'judging') {
    log.warn({ status: attempt.status }, '作答状态不能进入评判');
    throw new Error(`Attempt cannot be judged from status "${attempt.status}"`);
  }
  const task = loaded.state.tasks.find((item) => item.id === attempt.taskId);
  if (!task) {
    log.warn({}, '未找到作答对应的服务端任务');
    throw new Error(`Task not found: ${attempt.taskId}`);
  }

  let working = loaded.state;
  let expectedRevision = loaded.revision;
  if (attempt.status === 'received') {
    working = Domain.startTaskAttemptJudging(working, { attemptId: attempt.id }).state;
    saveWithConflictLog(repository, working, expectedRevision, log);
    expectedRevision += 1;
    log.info({ taskId: task.id }, '作答已转入评判中');
  }

  let judgement: TaskJudgement;
  if (requiresSemanticJudgement(task)) {
    const startedAt = Date.now();
    try {
      judgement = await judgeWithAI(task, attempt, aiJudge, input.judgedAt);
      log.info({ taskId: task.id, durationMs: Date.now() - startedAt }, 'AI 评判完成');
    } catch (error) {
      log.warn({
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      }, 'AI 评判失败或结果未通过校验，保留原始作答待重试');
      throw error;
    }
  } else {
    judgement = Domain.judgeTask({
      task,
      submission: attempt.submission,
      judgedAt: input.judgedAt,
      elapsedMs: attempt.validity.elapsedMs,
    });
    log.info({ taskId: task.id }, '规则评判完成');
  }

  const settled = Domain.settleTaskAttempt(working, {
    attemptId: attempt.id,
    judgement,
    now: input.now,
  });
  saveWithConflictLog(repository, settled.state, expectedRevision, log);
  log.info({
    taskId: task.id,
    judgedBy: judgement.judgedBy,
    fluencyChanges: settled.attempt.settlement.fluencyChanges
      .map((change) => `${change.dimension}:${change.before}->${change.after}`),
  }, '作答结算完成');
  return {
    feedback: settled.attempt.judgement.feedback,
    settlement: settled.attempt.settlement,
  };
}

function bindLogger(logger: AppLogger, bindings: Record<string, unknown>): AppLogger {
  return {
    debug: (obj, msg) => logger.debug({ ...bindings, ...obj }, msg),
    info: (obj, msg) => logger.info({ ...bindings, ...obj }, msg),
    warn: (obj, msg) => logger.warn({ ...bindings, ...obj }, msg),
    error: (obj, msg) => logger.error({ ...bindings, ...obj }, msg),
  };
}

function saveWithConflictLog(
  repository: LearningStateRepository,
  state: LearningState,
  expectedRevision: number,
  log: AppLogger,
): void {
  try {
    repository.save(state, expectedRevision);
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) {
      log.warn({
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      }, '保存学习状态时检测到并发冲突');
    }
    throw error;
  }
}

function requiresSemanticJudgement(task: LearningTask): boolean {
  const content = task.content;
  if (content.task === 'ENCODE') return false;
  if (content.task === 'RETRIEVE') return content.content.stage !== 'choice';
  return content.content.axis === 'P'
    || content.content.questions.some((question) => question.kind === 'free');
}

async function judgeWithAI(
  task: LearningTask,
  attempt: TaskAttempt,
  aiJudge: TaskAIJudge,
  judgedAt: ISODateTime,
): Promise<TaskJudgement> {
  const content = task.content;
  const result = await aiJudge.judge({ task, submission: attempt.submission });
  validateSemanticResult(task, result);
  const feedback = result.feedback;

  if (content.task === 'RETRIEVE') {
    const axis = content.content.axis;
    const accepted = result.retrieveAccepted === true;
    const dimension: DimensionJudgement = accepted
      ? { outcome: 'correct', score: 1 }
      : { outcome: 'incorrect', score: 0 };
    return { taskId: task.id, dimensions: { [axis]: dimension }, feedback, judgedBy: 'ai', judgedAt };
  }

  if (content.task !== 'FLUENCY') {
    throw new Error('ENCODE tasks do not require semantic judgement');
  }
  const fluency = content.content;
  if (fluency.axis === 'R') {
    if (attempt.submission.task !== 'FLUENCY' || attempt.submission.axis !== 'R') {
      throw new Error('Submission axis mismatch');
    }
    const dimension = Domain.judgeReadingFluencyAnswers(
      fluency,
      attempt.submission,
      result.readingFreeQuestions ?? [],
    );
    return { taskId: task.id, dimensions: { R: dimension }, feedback, judgedBy: 'ai', judgedAt };
  }

  if (attempt.submission.task !== 'FLUENCY' || attempt.submission.axis !== 'P') {
    throw new Error('Submission axis mismatch');
  }
  if (!Number.isFinite(attempt.validity.elapsedMs) || attempt.validity.elapsedMs <= 0) {
    throw new Error('Production fluency judging requires positive elapsedMs');
  }
  const production = result.production!;
  const dimension: DimensionJudgement = {
    outcome: production.targetPassed ? 'correct' : 'incorrect',
    score: production.targetPassed ? 1 : 0,
    targetPassed: production.targetPassed,
    overallPassed: production.overallPassed,
    speedWpm: Domain.productionSpeedWpm(attempt.submission.response, attempt.validity.elapsedMs),
  };
  return { taskId: task.id, dimensions: { P: dimension }, feedback, judgedBy: 'ai', judgedAt };
}

function validateSemanticResult(task: LearningTask, result: SemanticJudgementResult): void {
  if (result.taskId !== task.id) {
    throw new Error(`AI judgement belongs to another task: ${result.taskId}`);
  }
  const content = task.content;
  if (content.task === 'ENCODE') {
    throw new Error('ENCODE tasks do not require semantic judgement');
  }
  if (content.task === 'RETRIEVE') {
    if (typeof result.retrieveAccepted !== 'boolean') {
      throw new Error('AI judgement for a retrieve task requires retrieveAccepted');
    }
    return;
  }
  if (content.task !== 'FLUENCY') return;
  const fluency = content.content;
  if (fluency.axis === 'R') {
    const freeQuestionIds = new Set(fluency.questions
      .filter((question) => question.kind === 'free')
      .map((question) => question.id));
    const verdicts = result.readingFreeQuestions ?? [];
    const seen = new Set(verdicts.map((verdict) => verdict.questionId));
    if (verdicts.length !== freeQuestionIds.size || [...freeQuestionIds].some((id) => !seen.has(id))) {
      throw new Error('AI judgement must cover every free reading question exactly once');
    }
    return;
  }
  if (!result.production
    || typeof result.production.targetPassed !== 'boolean'
    || typeof result.production.overallPassed !== 'boolean') {
    throw new Error('AI judgement for a production task requires production targetPassed and overallPassed');
  }
}

function assertDateTime(value: string, path: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new RangeError(`${path} must be an ISO date-time`);
}
