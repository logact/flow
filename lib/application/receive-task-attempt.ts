import * as Domain from '../domain/functions';
import type { AttemptValidity, ISODateTime, LearningState, TaskAttempt, TaskSubmission } from '../domain/model';
import { logger as defaultLogger } from './logger';
import type { AppLogger } from './logger';
import { ConcurrencyConflictError } from './repository';
import type { LearningStateRepository } from './repository';

export interface ReceiveTaskAttemptInput {
  attemptId: string;
  taskId: string;
  submission: TaskSubmission;
  validity: AttemptValidity;
  receivedAt: ISODateTime;
}

/**
 * S10：接收学习任务作答。
 * 同一 attemptId 的重试直接返回已有作答，保证幂等；首次作答交由 Domain 校验任务与提交有效性，
 * 无论 received、invalid 还是 unavailable 都会持久化，只有 received 可以进入 S11 评判结算。
 */
export function receiveTaskAttempt(
  repository: LearningStateRepository,
  input: ReceiveTaskAttemptInput,
  logger: AppLogger = defaultLogger,
): TaskAttempt {
  const log = bindLogger(logger, { attemptId: input.attemptId, taskId: input.taskId });
  assertDateTime(input.receivedAt, 'receivedAt');
  const loaded = repository.load();
  const existing = loaded.state.attempts.find((item) => item.id === input.attemptId);
  if (existing) {
    log.debug({}, '作答已处理，返回已有记录');
    return existing;
  }
  const recorded = Domain.recordTaskAttempt(loaded.state, input);
  saveWithConflictLog(repository, recorded.state, loaded.revision, log);
  log.info({ status: recorded.attempt.status }, '学习任务作答已接收');
  return recorded.attempt;
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
