import type { LearningState } from '../domain/model';

/** 学习状态快照及其版本号；版本号随每次保存递增，用于乐观并发控制。 */
export interface LearningStateSnapshot {
  state: LearningState;
  revision: number;
}

export class ConcurrencyConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`LearningState revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'ConcurrencyConflictError';
  }
}

/**
 * 学习状态读写契约；用例只依赖该接口，测试使用内存实现，实际运行切换为 SQLite。
 * load 返回的快照不得被调用方修改；save 在版本号不一致时抛出并发冲突。
 */
export interface LearningStateRepository {
  load(): LearningStateSnapshot;
  save(next: LearningState, expectedRevision: number): LearningStateSnapshot;
}

export class InMemoryLearningStateRepository implements LearningStateRepository {
  private snapshot: LearningStateSnapshot;

  constructor(initial: LearningState) {
    this.snapshot = { state: initial, revision: 0 };
  }

  load(): LearningStateSnapshot {
    return this.snapshot;
  }

  save(next: LearningState, expectedRevision: number): LearningStateSnapshot {
    if (this.snapshot.revision !== expectedRevision) {
      throw new ConcurrencyConflictError(expectedRevision, this.snapshot.revision);
    }
    this.snapshot = { state: next, revision: expectedRevision + 1 };
    return this.snapshot;
  }
}
