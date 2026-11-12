import * as Domain from '../domain/functions';
import type { ISODateTime, Learner, LearningState } from '../domain/model';
import { logger as defaultLogger } from './logger';
import type { AppLogger } from './logger';
import { ConcurrencyConflictError } from './repository';
import type { LearningStateRepository } from './repository';

export interface CreateLearnerUseCaseInput {
  id: string;
  timezone: string;
  dailyTaskCapacity: number;
  now: ISODateTime;
}

export interface UpdateLearnerSettingsUseCaseInput {
  learnerId: string;
  dailyTaskCapacity?: number;
  timezone?: string;
  now: ISODateTime;
}

/**
 * S01（创建）：检查学习者不存在后创建并保存，返回保存后的学习者。
 * 新学习者的 currentVocabulary 为 null，需先完成词汇自评测评。
 */
export function createLearnerUseCase(
  repository: LearningStateRepository,
  input: CreateLearnerUseCaseInput,
  logger: AppLogger = defaultLogger,
): Learner {
  const log = bindLogger(logger, { learnerId: input.id });
  assertDateTime(input.now, 'now');
  const loaded = repository.load();
  if (loaded.state.learners.some((learner) => learner.id === input.id)) {
    log.warn({}, '学习者已存在，不能重复创建');
    throw new Error(`Learner already exists: ${input.id}`);
  }
  const learner = Domain.createLearner(input);
  const next: LearningState = {
    ...loaded.state,
    learners: [...loaded.state.learners, learner],
  };
  saveWithConflictLog(repository, next, loaded.revision, log);
  log.info({
    dailyTaskCapacity: learner.dailyTaskCapacity,
    timezone: learner.timezone,
  }, '学习者已创建');
  return reloadLearner(repository, learner.id);
}

/**
 * S01（更新）：加载学习者并应用新容量或时区后保存。
 * 更新容量不直接重写历史计划；下一次执行 S07～S09 时才应用新容量。
 */
export function updateLearnerSettingsUseCase(
  repository: LearningStateRepository,
  input: UpdateLearnerSettingsUseCaseInput,
  logger: AppLogger = defaultLogger,
): Learner {
  const log = bindLogger(logger, { learnerId: input.learnerId });
  assertDateTime(input.now, 'now');
  const loaded = repository.load();
  const existing = loaded.state.learners.find((learner) => learner.id === input.learnerId);
  if (!existing) {
    log.warn({}, '未找到学习者');
    throw new Error(`Learner not found: ${input.learnerId}`);
  }
  const updated = Domain.updateLearnerSettings(existing, input);
  const next: LearningState = {
    ...loaded.state,
    learners: loaded.state.learners.map((learner) => (learner.id === updated.id ? updated : learner)),
  };
  saveWithConflictLog(repository, next, loaded.revision, log);
  log.info({
    dailyTaskCapacity: updated.dailyTaskCapacity,
    timezone: updated.timezone,
  }, '学习设置已更新');
  return reloadLearner(repository, updated.id);
}

function reloadLearner(repository: LearningStateRepository, learnerId: string): Learner {
  const reloaded = repository.load().state.learners.find((learner) => learner.id === learnerId);
  if (!reloaded) {
    throw new Error(`Learner not persisted: ${learnerId}`);
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
