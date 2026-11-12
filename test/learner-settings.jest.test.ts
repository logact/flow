/// <reference types="jest" />

import {
  createLearnerUseCase,
  updateLearnerSettingsUseCase,
} from '../lib/application/learner-settings';
import {
  ConcurrencyConflictError,
  InMemoryLearningStateRepository,
} from '../lib/application/repository';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';
import { silentLogger } from './helpers/silent-logger';

const at = {
  created: '2026-11-12T00:00:00.000Z',
  updated: '2026-11-12T01:00:00.000Z',
};

function emptyState(): Model.LearningState {
  return {
    learners: [],
    vocabularyAssessments: [],
    vocabularyAssessmentTasks: [],
    vocabularyAssessmentAttempts: [],
    materials: [],
    materialAnalyses: [],
    goals: [],
    goalMaterials: [],
    knowledgePoints: [],
    knowledgePointVocabularyClassifications: [],
    goalKnowledgePoints: [],
    goalKnowledgePointSources: [],
    learnerKnowledgePoints: [],
    studyPlans: [],
    tasks: [],
    attempts: [],
  };
}

function repositoryWithLearner(): InMemoryLearningStateRepository {
  const repository = new InMemoryLearningStateRepository(emptyState());
  createLearnerUseCase(repository, {
    id: 'learner-1',
    timezone: 'Asia/Shanghai',
    dailyTaskCapacity: 3,
    now: at.created,
  }, silentLogger);
  return repository;
}

describe('S01 创建学习者', () => {
  it('创建并持久化学习者，新学习者 currentVocabulary 为 null', () => {
    const repository = new InMemoryLearningStateRepository(emptyState());
    const learner = createLearnerUseCase(repository, {
      id: 'learner-1',
      timezone: 'Asia/Shanghai',
      dailyTaskCapacity: 5,
      now: at.created,
    }, silentLogger);

    expect(learner).toEqual({
      id: 'learner-1',
      currentVocabulary: null,
      dailyTaskCapacity: 5,
      timezone: 'Asia/Shanghai',
      createdAt: at.created,
      updatedAt: at.created,
    });

    const reloaded = repository.load();
    expect(reloaded.revision).toBe(1);
    expect(reloaded.state.learners).toHaveLength(1);
    expect(reloaded.state.learners[0]).toEqual(learner);
    expect(() => validateLearningState(reloaded.state)).not.toThrow();
  });

  it('学习者已存在时拒绝重复创建，状态保持不变', () => {
    const repository = repositoryWithLearner();

    expect(() => createLearnerUseCase(repository, {
      id: 'learner-1',
      timezone: 'Asia/Tokyo',
      dailyTaskCapacity: 10,
      now: at.updated,
    }, silentLogger)).toThrow('Learner already exists: learner-1');

    const reloaded = repository.load();
    expect(reloaded.revision).toBe(1);
    expect(reloaded.state.learners[0].timezone).toBe('Asia/Shanghai');
    expect(reloaded.state.learners[0].dailyTaskCapacity).toBe(3);
  });

  it('now 不是合法 ISO 时间时拒绝创建', () => {
    const repository = new InMemoryLearningStateRepository(emptyState());
    expect(() => createLearnerUseCase(repository, {
      id: 'learner-1',
      timezone: 'Asia/Shanghai',
      dailyTaskCapacity: 5,
      now: 'not-a-date',
    }, silentLogger)).toThrow(RangeError);
    expect(repository.load().state.learners).toHaveLength(0);
  });
});

describe('S01 更新学习设置', () => {
  it('更新容量后保存，返回保存后的学习者', () => {
    const repository = repositoryWithLearner();
    const learner = updateLearnerSettingsUseCase(repository, {
      learnerId: 'learner-1',
      dailyTaskCapacity: 8,
      now: at.updated,
    }, silentLogger);

    expect(learner.dailyTaskCapacity).toBe(8);
    expect(learner.timezone).toBe('Asia/Shanghai');
    expect(learner.createdAt).toBe(at.created);
    expect(learner.updatedAt).toBe(at.updated);

    const reloaded = repository.load();
    expect(reloaded.revision).toBe(2);
    expect(reloaded.state.learners[0]).toEqual(learner);
    expect(() => validateLearningState(reloaded.state)).not.toThrow();
  });

  it('只更新时区时保留原容量', () => {
    const repository = repositoryWithLearner();
    const learner = updateLearnerSettingsUseCase(repository, {
      learnerId: 'learner-1',
      timezone: 'Asia/Tokyo',
      now: at.updated,
    }, silentLogger);

    expect(learner.timezone).toBe('Asia/Tokyo');
    expect(learner.dailyTaskCapacity).toBe(3);
    expect(learner.updatedAt).toBe(at.updated);
  });

  it('更新容量不直接重写历史计划', () => {
    const repository = repositoryWithLearner();
    const snapshot = repository.load();
    const studyPlan: Model.DailyStudyPlan = {
      id: 'plan-2026-11-12',
      learnerId: 'learner-1',
      date: '2026-11-12',
      taskCapacity: 3,
      taskIds: ['task-1', 'task-2', 'task-3'],
      createdAt: at.created,
      updatedAt: at.created,
    };
    repository.save(
      { ...snapshot.state, studyPlans: [studyPlan] },
      snapshot.revision,
    );

    updateLearnerSettingsUseCase(repository, {
      learnerId: 'learner-1',
      dailyTaskCapacity: 8,
      now: at.updated,
    }, silentLogger);

    const reloaded = repository.load();
    expect(reloaded.state.learners[0].dailyTaskCapacity).toBe(8);
    expect(reloaded.state.studyPlans).toEqual([studyPlan]);
  });

  it('学习者不存在时拒绝更新', () => {
    const repository = repositoryWithLearner();
    expect(() => updateLearnerSettingsUseCase(repository, {
      learnerId: 'learner-missing',
      dailyTaskCapacity: 8,
      now: at.updated,
    }, silentLogger)).toThrow('Learner not found: learner-missing');
    expect(repository.load().revision).toBe(1);
  });

  it('保存时检测到并发冲突则抛出且不覆盖状态', () => {
    const repository = repositoryWithLearner();
    const stale = repository.load();
    // 模拟另一处写入使版本号前进，过期快照保存时必然冲突。
    repository.save(stale.state, stale.revision);

    expect(() => updateLearnerSettingsUseCase({
      load: () => stale,
      save: repository.save.bind(repository),
    }, {
      learnerId: 'learner-1',
      dailyTaskCapacity: 8,
      now: at.updated,
    }, silentLogger)).toThrow(ConcurrencyConflictError);

    const reloaded = repository.load();
    expect(reloaded.state.learners[0].dailyTaskCapacity).toBe(3);
  });
});
