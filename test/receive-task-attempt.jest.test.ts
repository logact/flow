/// <reference types="jest" />

import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import { receiveTaskAttempt } from '../lib/application/receive-task-attempt';
import type { AppLogger } from '../lib/application/logger';
import { ConcurrencyConflictError, InMemoryLearningStateRepository } from '../lib/application/repository';
import * as Domain from '../lib/domain/functions';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';
import { silentLogger } from './helpers/silent-logger';

const list = { id: 'bnc-coca-l6', version: '2.0.0' };
const families: Domain.VocabularyAssessmentWordFamily[] = vocabularyFixture.families.map((family) => ({
  ...family,
  band: family.band as Model.VocabularyBand,
}));
const at = {
  created: '2026-11-12T00:00:00.000Z',
  answered: '2026-11-12T00:10:00.000Z',
  planned: '2026-11-12T00:30:00.000Z',
  received: '2026-11-12T00:40:00.000Z',
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

// 与领域函数测试相同的路径：真实走一遍定级与初始化，使状态通过约束校验。
function buildInitializedState(): Model.LearningState {
  const learner = Domain.createLearner({
    id: 'learner-1',
    timezone: 'Asia/Shanghai',
    dailyTaskCapacity: 3,
    now: at.created,
  });
  const samples = Domain.sampleVocabularyForAssessment({
    list,
    families,
    sampleCounts: { '2k': 1 },
    seed: 's10-test',
  });
  const assessmentTasks = Domain.generateVocabularyAssessmentTasks({ samples, taskIds: ['assessment-task-1'] });
  const assessment = Domain.createVocabularyAssessment({
    id: 'assessment-1',
    learnerId: learner.id,
    tasks: assessmentTasks,
    now: at.created,
  });
  const assessmentAttempt = Domain.recordVocabularyAssessmentAttempt({
    attemptId: 'assessment-attempt-1',
    assessment,
    task: assessmentTasks[0],
    previousAttempts: [],
    known: false,
    answeredAt: at.answered,
  });
  const completed = Domain.completeVocabularyAssessment({
    learner,
    assessment,
    tasks: assessmentTasks,
    attempts: [assessmentAttempt],
    list,
    bandWordFamilyCounts: { '2k': 2000 },
    now: at.answered,
  });
  const material = Domain.createMaterial({
    id: 'material-1',
    learnerId: learner.id,
    title: 'Morning run',
    filename: 'morning-run.md',
    format: 'markdown',
    mimeType: 'text/markdown',
    checksum: 'checksum-1',
    storageKey: null,
    extractedText: 'I run every morning.',
    extractionMetadata: { extractor: 'test' },
    now: at.answered,
  });
  const terms = Domain.extractMaterialTerms(material);
  const analysis = Domain.analyzeMaterial({
    analysisId: 'analysis-1',
    material,
    analyzerVersion: 'test-v1',
    now: at.answered,
    assignments: terms.map((term) => ({
      lemma: term.lemma,
      senseId: 'placeholder:1',
      partOfSpeech: null,
      definition: `Meaning of ${term.lemma} in the source material`,
      occurrences: term.occurrences,
    })),
  });
  const goal = Domain.createLearningGoal({
    id: 'goal-1',
    learnerId: learner.id,
    title: 'Core vocabulary',
    targetFluency: { R: 100, P: 100 },
    now: at.answered,
  });
  const scope = Domain.addAnalyzedMaterialToGoal({
    goal,
    material,
    analysis,
    existingCandidates: [],
    existingSources: [],
    addedAt: at.answered,
  });
  const knowledgePoint = scope.knowledgePoints.find((item) => item.kind === 'word' && item.lemma === 'run');
  if (!knowledgePoint) throw new Error('run was not analyzed');
  const candidate = Domain.setGoalKnowledgePointSelection(
    scope.candidates.find((item) => item.knowledgePointId === knowledgePoint.id)!,
    { selection: 'included', now: at.answered },
  );
  const classification: Model.KnowledgePointVocabularyClassification = {
    knowledgePointId: knowledgePoint.id,
    list,
    band: '2k',
  };
  const derived = Domain.deriveInitialFluency({
    vocabulary: completed.learner.currentVocabulary!,
    classification,
    policyVersion: 'test-v1',
  });
  const learning = Domain.initializeLearnerKnowledgePoint({
    learnerId: learner.id,
    knowledgePoint,
    derived,
    now: at.answered,
  });
  return {
    ...emptyState(),
    learners: [completed.learner],
    vocabularyAssessments: [completed.assessment],
    vocabularyAssessmentTasks: assessmentTasks,
    vocabularyAssessmentAttempts: [assessmentAttempt],
    materials: [material],
    materialAnalyses: [analysis],
    goals: [scope.goal],
    goalMaterials: [scope.materialLink],
    knowledgePoints: [knowledgePoint],
    knowledgePointVocabularyClassifications: [classification],
    goalKnowledgePoints: [candidate],
    goalKnowledgePointSources: scope.sources.filter((source) => source.knowledgePointId === knowledgePoint.id),
    learnerKnowledgePoints: [learning],
  };
}

function makeTask(
  state: Model.LearningState,
  specification: Domain.TaskSpecification,
  taskId: string,
): { state: Model.LearningState; task: Model.LearningTask } {
  const generated = Domain.generateLearningTask({
    specification,
    knowledgePoint: state.knowledgePoints[0],
    sourceMaterials: state.materials,
  });
  const task = Domain.createLearningTask({
    id: taskId,
    learnerId: state.learners[0].id,
    specification,
    generated,
    issuedAt: at.planned,
  });
  return { state: { ...state, tasks: [...state.tasks, task] }, task };
}

function receiveInput(taskId: string, attemptId: string, submission: Model.TaskSubmission) {
  return {
    attemptId,
    taskId,
    submission,
    validity: { elapsedMs: 5000, interrupted: false },
    receivedAt: at.received,
  };
}

function captureLogger(): { logger: AppLogger; entries: Array<{ obj: Record<string, unknown>; msg: string }> } {
  const entries: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const record = (obj: Record<string, unknown>, msg: string) => entries.push({ obj, msg });
  return {
    entries,
    logger: {
      debug: record,
      info: record,
      warn: record,
      error: record,
    },
  };
}

describe('S10 接收学习任务作答', () => {
  test('首次提交有效作答：received 作答持久化，状态通过约束校验', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const repository = new InMemoryLearningStateRepository(state);

    const attempt = receiveTaskAttempt(repository, receiveInput(task.id, 'attempt-1', { task: 'ENCODE' }), silentLogger);

    expect(attempt.status).toBe('received');
    const saved = repository.load();
    expect(saved.revision).toBe(1);
    expect(saved.state.attempts).toHaveLength(1);
    expect(saved.state.attempts[0]).toEqual(attempt);
    expect(saved.state.tasks[0].status).toBe('issued');
    expect(validateLearningState(saved.state)).toEqual([]);
  });

  test('同一 attemptId 重试：返回已有作答，不新增记录也不推进版本号', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const repository = new InMemoryLearningStateRepository(state);
    const input = receiveInput(task.id, 'attempt-1', { task: 'ENCODE' });

    const first = receiveTaskAttempt(repository, input, silentLogger);
    const retried = receiveTaskAttempt(repository, input, silentLogger);

    expect(retried).toEqual(first);
    const saved = repository.load();
    expect(saved.state.attempts).toHaveLength(1);
    expect(saved.revision).toBe(1);
  });

  test('中断作答：invalid 作答同样持久化，但不进入评判', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const repository = new InMemoryLearningStateRepository(state);

    const attempt = receiveTaskAttempt(repository, {
      ...receiveInput(task.id, 'attempt-interrupted', { task: 'ENCODE' }),
      validity: { elapsedMs: 5000, interrupted: true },
    }, silentLogger);

    expect(attempt.status).toBe('invalid');
    expect(attempt.statusReason).not.toBeNull();
    expect(() => Domain.startTaskAttemptJudging(repository.load().state, { attemptId: attempt.id })).toThrow();
  });

  test('任务不再处于 issued：返回 unavailable 作答并持久化', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-cancelled');
    const { status: _status, completedAt: _completedAt, ...taskBase } = task;
    const cancelled: Model.LearningTask = { ...taskBase, status: 'cancelled', completedAt: null };
    const repository = new InMemoryLearningStateRepository({ ...state, tasks: [cancelled] });

    const attempt = receiveTaskAttempt(
      repository, receiveInput(task.id, 'attempt-cancelled', { task: 'ENCODE' }), silentLogger);

    expect(attempt.status).toBe('unavailable');
    expect(repository.load().state.attempts).toHaveLength(1);
  });

  test('同一任务换 attemptId 重复作答：抛错且不写入', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const repository = new InMemoryLearningStateRepository(state);
    receiveTaskAttempt(repository, receiveInput(task.id, 'attempt-1', { task: 'ENCODE' }), silentLogger);

    expect(() => receiveTaskAttempt(
      repository, receiveInput(task.id, 'attempt-2', { task: 'ENCODE' }), silentLogger))
      .toThrow('Attempt ID and task ID must be unique');

    const saved = repository.load();
    expect(saved.state.attempts).toHaveLength(1);
    expect(saved.revision).toBe(1);
  });

  test('保存时检测到并发冲突则抛出且不写入作答', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const repository = new InMemoryLearningStateRepository(state);
    const stale = repository.load();
    // 模拟另一处写入使版本号前进，过期快照保存时必然冲突。
    repository.save(stale.state, stale.revision);

    expect(() => receiveTaskAttempt({
      load: () => stale,
      save: repository.save.bind(repository),
    }, receiveInput(task.id, 'attempt-1', { task: 'ENCODE' }), silentLogger))
      .toThrow(ConcurrencyConflictError);

    expect(repository.load().state.attempts).toHaveLength(0);
  });

  test('receivedAt 非法时报 RangeError，不加载也不写入', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const repository = new InMemoryLearningStateRepository(state);

    expect(() => receiveTaskAttempt(repository, {
      ...receiveInput(task.id, 'attempt-1', { task: 'ENCODE' }),
      receivedAt: 'not-a-date',
    }, silentLogger)).toThrow(RangeError);

    expect(repository.load().state.attempts).toHaveLength(0);
    expect(repository.load().revision).toBe(0);
  });

  test('重复 attemptId 命中已有作答时记录 debug 日志', () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const repository = new InMemoryLearningStateRepository(state);
    const input = receiveInput(task.id, 'attempt-1', { task: 'ENCODE' });
    receiveTaskAttempt(repository, input, silentLogger);
    const { logger, entries } = captureLogger();

    receiveTaskAttempt(repository, input, logger);

    expect(entries).toContainEqual(expect.objectContaining({ msg: '作答已处理，返回已有记录' }));
  });
});
