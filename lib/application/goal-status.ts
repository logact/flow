import { changeLearningGoalStatus } from '../domain/functions';
import type { ISODateTime, LearningGoal, LearningState } from '../domain/model';
import { logger as defaultLogger } from './logger';
import type { AppLogger } from './logger';
import { ConcurrencyConflictError } from './repository';
import type { LearningStateRepository } from './repository';

export interface ChangeLearningGoalStatusUseCaseInput {
  goalId: string;
  status: 'completed' | 'archived';
  now: ISODateTime;
}

/**
 * S12：完成或归档学习目标。
 * 加载目标并调用 changeLearningGoalStatus 后保存；材料、候选知识点、任务和学习历史全部保留。
 * 本用例不接受 'active'，归档/完成后不允许通过 S12 复活目标；
 * 状态未变化时不写入；后续 S07 起不再为非 active 目标生成新任务，既有未做任务由 S07 决策取消。
 */
export function changeLearningGoalStatusUseCase(
  repository: LearningStateRepository,
  input: ChangeLearningGoalStatusUseCaseInput,
  logger: AppLogger = defaultLogger,
): LearningGoal {
  const log = bindLogger(logger, { goalId: input.goalId });
  assertDateTime(input.now, 'now');
  if (input.status !== 'completed' && input.status !== 'archived') {
    throw new RangeError(`status must be 'completed' or 'archived'`);
  }
  const loaded = repository.load();
  const existing = loaded.state.goals.find((goal) => goal.id === input.goalId);
  if (!existing) {
    log.warn({}, '未找到学习目标');
    throw new Error(`Learning goal not found: ${input.goalId}`);
  }
  if (existing.status === input.status) {
    log.info({ status: input.status }, '目标状态未变化，跳过保存');
    return existing;
  }
  const updated = changeLearningGoalStatus(existing, { status: input.status, now: input.now });
  const next: LearningState = {
    ...loaded.state,
    goals: loaded.state.goals.map((goal) => (goal.id === updated.id ? updated : goal)),
  };
  saveWithConflictLog(repository, next, loaded.revision, log);
  log.info({ status: updated.status }, '学习目标状态已更新');
  const reloaded = repository.load().state.goals.find((goal) => goal.id === updated.id);
  if (!reloaded) {
    throw new Error(`Learning goal not persisted: ${input.goalId}`);
  }
  return reloaded;
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

function assertDateTime(value: string, path: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new RangeError(`${path} must be an ISO date-time`);
}
