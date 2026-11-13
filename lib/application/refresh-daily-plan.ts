import { planDailyStudy } from '../domain/functions';
import type {
  DailyStudyPlan,
  ISODateTime,
  LearningTask,
  LearningTaskView,
  LocalDate,
} from '../domain/model';
import { applyDailyPlanUseCase } from './apply-daily-plan';
import { logger as defaultLogger, type AppLogger } from './logger';
import type { LearningTaskRepository, TaskGenerationAIProvider } from './ports';
import type { LearningStateRepository } from './repository';
import { generateLearningTaskUseCase } from './task-generation';

export interface RefreshDailyPlanUseCaseInput {
  learnerId: string;
  date: LocalDate;
  now: ISODateTime;
}

export type RefreshDailyPlanFailure =
  | 'learner_not_found'
  | 'task_generation_failed'
  | 'invalid_decision'
  | 'concurrency_conflict';

export type RefreshDailyPlanResult =
  | { ok: true; plan: DailyStudyPlan; tasks: LearningTaskView[] }
  | { ok: false; reason: RefreshDailyPlanFailure };

/** 并发冲突后从排期决策整体重试的上限；用尽后返回冲突失败。 */
export const MAX_PLAN_REFRESH_ATTEMPTS = 3;

/**
 * R1：刷新每日计划（S07～S09 编排）。
 * 每次尝试都重新加载状态并调用 Domain planDailyStudy 得到暂态决策；
 * 决策中的全部 new 位置交由 S08 生成暂态任务（分配任务 ID 并注入 issuedAt），
 * 任一生成失败立即整体返回失败、不落任何状态；new 为空时不调用 AI，
 * 直接走 S09 使取消、过期等状态变化照常落库。
 * 全部生成成功后调用 S09 应用决策；并发冲突时从第 1 步重新执行，重试有上限。
 */
export async function refreshDailyPlanUseCase(
  deps: {
    repository: LearningStateRepository;
    taskRepository: LearningTaskRepository;
    aiProvider: TaskGenerationAIProvider;
    newTaskId?: () => string;
    newPlanId?: () => string;
    maxAttempts?: number;
    logger?: AppLogger;
  },
  input: RefreshDailyPlanUseCaseInput,
): Promise<RefreshDailyPlanResult> {
  const logger = deps.logger ?? defaultLogger;
  const newTaskId = deps.newTaskId ?? (() => crypto.randomUUID());
  const newPlanId = deps.newPlanId ?? (() => crypto.randomUUID());
  const maxAttempts = deps.maxAttempts ?? MAX_PLAN_REFRESH_ATTEMPTS;
  const { learnerId, date, now } = input;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const snapshot = deps.repository.load();
    let decision;
    try {
      decision = planDailyStudy(snapshot.state, { learnerId, date, now });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Learner not found:')) {
        logger.warn({ learnerId }, '刷新每日计划：学习者不存在');
        return { ok: false, reason: 'learner_not_found' };
      }
      throw error;
    }

    const newTasks: LearningTask[] = [];
    for (const position of decision.tasks) {
      if (position.source !== 'new') continue;
      const taskId = newTaskId();
      const generated = await generateLearningTaskUseCase(
        { repository: deps.taskRepository, aiProvider: deps.aiProvider, logger },
        { taskId, learnerId, specification: position.specification, issuedAt: now },
      );
      if (!generated.ok) {
        logger.error({
          learnerId, date, taskId, attempt,
          goalId: position.specification.goalId,
          wordId: position.specification.wordId,
          task: position.specification.task,
          reason: generated.reason,
        }, '刷新每日计划：任务生成失败，本次不落任何状态');
        return { ok: false, reason: 'task_generation_failed' };
      }
      newTasks.push(generated.task);
    }

    const applied = await applyDailyPlanUseCase(
      { repository: deps.repository, logger },
      { planId: newPlanId(), decision, newTasks, now },
    );
    if (applied.ok) {
      logger.info({
        learnerId, date, attempt,
        planId: applied.plan.id,
        taskCount: applied.plan.taskIds.length,
        newTaskCount: newTasks.length,
        durationMs: Date.now() - startedAt,
      }, '刷新每日计划：计划已保存');
      return { ok: true, plan: applied.plan, tasks: applied.tasks };
    }
    if (applied.reason === 'invalid_decision') {
      logger.error({ learnerId, date, attempt }, '刷新每日计划：决策校验失败');
      return { ok: false, reason: 'invalid_decision' };
    }
    logger.warn({ learnerId, date, attempt, maxAttempts }, '刷新每日计划：并发冲突，从排期决策重新执行');
  }

  logger.error({ learnerId, date, attempts: maxAttempts }, '刷新每日计划：并发冲突重试次数用尽');
  return { ok: false, reason: 'concurrency_conflict' };
}
