import {
  applyDailyStudyDecision,
  toLearningTaskView,
} from '../domain/functions';
import type { DailyStudyDecision } from '../domain/functions';
import type {
  DailyStudyPlan,
  ISODateTime,
  LearningState,
  LearningTask,
  LearningTaskView,
} from '../domain/model';
import { logger as defaultLogger, type AppLogger } from './logger';
import { ConcurrencyConflictError, type LearningStateRepository } from './repository';

export interface ApplyDailyPlanUseCaseInput {
  planId?: string;
  decision: DailyStudyDecision;
  newTasks: LearningTask[];
  now: ISODateTime;
}

export type ApplyDailyPlanFailure = 'invalid_decision' | 'concurrency_conflict';

export type ApplyDailyPlanResult =
  | { ok: true; plan: DailyStudyPlan; tasks: LearningTaskView[] }
  | { ok: false; reason: ApplyDailyPlanFailure };

/**
 * S09：应用排期决策并保存每日计划。
 * 重新加载完整状态后调用 applyDailyStudyDecision 完成全部校验；
 * 校验或并发冲突时不保存任何状态，成功时计划、新任务与过期/取消状态变化
 * 通过乐观锁一次写入。返回按决策顺序排列的公开任务视图。
 */
export async function applyDailyPlanUseCase(
  deps: {
    repository: LearningStateRepository;
    logger?: AppLogger;
  },
  input: ApplyDailyPlanUseCaseInput,
): Promise<ApplyDailyPlanResult> {
  const logger = deps.logger ?? defaultLogger;
  const startedAt = Date.now();
  const { decision, newTasks, now } = input;
  const { learnerId, date } = decision;

  const snapshot = deps.repository.load();
  let next: LearningState;
  try {
    next = applyDailyStudyDecision(snapshot.state, {
      planId: input.planId,
      decision,
      newTasks,
      now,
    });
  } catch (error) {
    logger.error(
      { learnerId, date, error: error instanceof Error ? error.message : String(error) },
      '应用每日计划：决策校验失败',
    );
    return { ok: false, reason: 'invalid_decision' };
  }

  try {
    deps.repository.save(next, snapshot.revision);
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) {
      logger.warn(
        { learnerId, date, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision },
        '应用每日计划：状态已被并发修改，请从排期决策重新执行',
      );
      return { ok: false, reason: 'concurrency_conflict' };
    }
    throw error;
  }

  const plan = next.studyPlans.find(
    (item) => item.learnerId === learnerId && item.date === date,
  )!;
  const tasks = plan.taskIds.map((taskId) => {
    const task = next.tasks.find((item) => item.id === taskId)!;
    return toLearningTaskView(task);
  });
  logger.info({
    planId: plan.id,
    learnerId,
    date,
    taskCount: plan.taskIds.length,
    durationMs: Date.now() - startedAt,
  }, '应用每日计划：计划已保存');
  return { ok: true, plan, tasks };
}
