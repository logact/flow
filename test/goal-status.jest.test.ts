/// <reference types="jest" />

import { changeLearningGoalStatusUseCase } from '../lib/application/goal-status';
import { silentLogger } from './helpers/silent-logger';
import { ConcurrencyConflictError, InMemoryLearningStateRepository } from '../lib/application/repository';
import * as Domain from '../lib/domain/functions';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';
import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';

const list = { id: 'bnc-coca-l6', version: '2.0.0' };
const families: Domain.VocabularyAssessmentWordFamily[] = vocabularyFixture.families.map((family) => ({
  ...family,
  band: family.band as Model.VocabularyBand,
}));
const at = {
  created: '2026-11-12T00:00:00.000Z',
  answered: '2026-11-12T00:10:00.000Z',
  planned: '2026-11-12T00:30:00.000Z',
  archived: '2026-11-12T12:00:00.000Z',
  nextDay: '2026-11-13T01:00:00.000Z',
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

/** 与 test/domain-functions.jest.test.ts 相同的最小闭环状态：定级完成、目标已纳入并初始化一个词。 */
function buildInitializedState() {
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
    seed: 'domain-test',
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
  const analysis = Domain.analyzeMaterial({
    analysisId: 'analysis-1',
    material,
    analyzerVersion: 'test-v1',
    now: at.answered,
    assignments: Domain.extractMaterialTerms(material).map((term) => ({
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
  const undecided = scope.candidates.find((candidate) => candidate.knowledgePointId === knowledgePoint.id)!;
  const candidate = Domain.setGoalKnowledgePointSelection(undecided, { selection: 'included', now: at.answered });
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
  const state: Model.LearningState = {
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
  return { state, material, knowledgePoint };
}

/** 排期并签发一项任务，模拟目标归档前已有未做任务。 */
function withIssuedTask(state: Model.LearningState, material: Model.Material, knowledgePoint: Model.KnowledgePoint) {
  const decision = Domain.planDailyStudy(state, { learnerId: 'learner-1', date: '2026-11-12', now: at.planned });
  const position = decision.tasks[0];
  if (position.source !== 'new') throw new Error('Expected a new task');
  const generated = Domain.generateLearningTask({
    specification: position.specification,
    knowledgePoint,
    sourceMaterials: [material],
  });
  const task = Domain.createLearningTask({
    id: 'task-1',
    learnerId: 'learner-1',
    specification: position.specification,
    generated,
    issuedAt: at.planned,
  });
  return Domain.applyDailyStudyDecision(state, { planId: 'plan-1', decision, newTasks: [task], now: at.planned });
}

describe('S12：完成或归档学习目标', () => {
  test('归档目标：状态与修改时间更新，其余字段不变，历史记录全部保留', () => {
    const { state } = buildInitializedState();
    const repository = new InMemoryLearningStateRepository(state);
    const before = repository.load().state;

    const goal = changeLearningGoalStatusUseCase(repository, {
      goalId: 'goal-1',
      status: 'archived',
      now: at.archived,
    }, silentLogger);

    expect(goal).toEqual({ ...before.goals[0], status: 'archived', updatedAt: at.archived });
    const after = repository.load().state;
    expect(after.goalMaterials).toEqual(before.goalMaterials);
    expect(after.goalKnowledgePoints).toEqual(before.goalKnowledgePoints);
    expect(after.learnerKnowledgePoints).toEqual(before.learnerKnowledgePoints);
    expect(after.knowledgePoints).toEqual(before.knowledgePoints);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.attempts).toEqual(before.attempts);
    expect(validateLearningState(after)).toEqual([]);
  });

  test('完成目标：状态变为 completed', () => {
    const { state } = buildInitializedState();
    const repository = new InMemoryLearningStateRepository(state);

    const goal = changeLearningGoalStatusUseCase(repository, {
      goalId: 'goal-1',
      status: 'completed',
      now: at.archived,
    }, silentLogger);

    expect(goal.status).toBe('completed');
    expect(goal.updatedAt).toBe(at.archived);
    expect(validateLearningState(repository.load().state)).toEqual([]);
  });

  test('重复归档是幂等的：状态不变时不产生新写入', () => {
    const { state } = buildInitializedState();
    const repository = new InMemoryLearningStateRepository(state);
    changeLearningGoalStatusUseCase(repository, { goalId: 'goal-1', status: 'archived', now: at.archived }, silentLogger);
    const revisionAfterFirst = repository.load().revision;

    const goal = changeLearningGoalStatusUseCase(repository, {
      goalId: 'goal-1',
      status: 'archived',
      now: at.nextDay,
    }, silentLogger);

    expect(goal.status).toBe('archived');
    expect(goal.updatedAt).toBe(at.archived);
    expect(repository.load().revision).toBe(revisionAfterFirst);
  });

  test('目标不存在时报错，不写入', () => {
    const { state } = buildInitializedState();
    const repository = new InMemoryLearningStateRepository(state);

    expect(() => changeLearningGoalStatusUseCase(repository, {
      goalId: 'goal-missing',
      status: 'archived',
      now: at.archived,
    }, silentLogger)).toThrow('Learning goal not found: goal-missing');
    expect(repository.load().revision).toBe(0);
  });

  test('运行时拒绝 active：S12 不支持复活目标', () => {
    const { state } = buildInitializedState();
    const repository = new InMemoryLearningStateRepository(state);

    expect(() => changeLearningGoalStatusUseCase(repository, {
      goalId: 'goal-1',
      status: 'active' as never,
      now: at.archived,
    }, silentLogger)).toThrow(RangeError);
    expect(repository.load().state.goals[0].status).toBe('active');
  });

  test('归档后重新排期：不再产生该目标的新任务，既有未做任务由决策取消', () => {
    const { state, material, knowledgePoint } = buildInitializedState();
    const withTask = withIssuedTask(state, material, knowledgePoint);
    expect(withTask.tasks[0].status).toBe('issued');
    const repository = new InMemoryLearningStateRepository(withTask);

    changeLearningGoalStatusUseCase(repository, { goalId: 'goal-1', status: 'archived', now: at.archived }, silentLogger);

    const decision = Domain.planDailyStudy(repository.load().state, {
      learnerId: 'learner-1',
      date: '2026-11-13',
      now: at.nextDay,
    });
    const newSpecs = decision.tasks.filter((item) => item.source === 'new');
    expect(newSpecs).toEqual([]);
    expect(decision.cancelTaskIds).toContain('task-1');
    expect(validateLearningState(repository.load().state)).toEqual([]);
  });

  test('保存时检测到并发冲突会抛出，不吞错', () => {
    const { state } = buildInitializedState();
    const repository = new InMemoryLearningStateRepository(state);
    const conflictingRepository = {
      load: () => repository.load(),
      save: () => { throw new ConcurrencyConflictError(0, 1); },
    };

    expect(() => changeLearningGoalStatusUseCase(conflictingRepository, {
      goalId: 'goal-1',
      status: 'archived',
      now: at.archived,
    }, silentLogger)).toThrow(ConcurrencyConflictError);
    expect(repository.load().state.goals[0].status).toBe('active');
  });
});
