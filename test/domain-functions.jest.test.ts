/// <reference types="jest" />

import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import * as Domain from '../lib/domain/functions';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';

const list = { id: 'bnc-coca-l6', version: '2.0.0' };
const families: Domain.VocabularyAssessmentWordFamily[] = vocabularyFixture.families.map((family) => ({
  ...family,
  band: family.band as Model.VocabularyBand,
}));
const at = {
  created: '2026-11-12T00:00:00.000Z',
  answered: '2026-11-12T00:10:00.000Z',
  planned: '2026-11-12T00:30:00.000Z',
  judged: '2026-11-12T00:40:00.000Z',
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
    selectedOptionId: 'b',
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

describe('真实领域函数', () => {
  test('定级、材料选词、排期、作答结算与次日复习形成闭环', () => {
    const { state, material, knowledgePoint } = buildInitializedState();
    expect(validateLearningState(state)).toEqual([]);

    const decision = Domain.planDailyStudy(state, {
      learnerId: 'learner-1',
      date: '2026-11-12',
      now: at.planned,
    });
    expect(decision.tasks).toEqual([{
      source: 'new',
      specification: { goalId: 'goal-1', wordId: knowledgePoint.id, task: 'ENCODE' },
    }]);
    const position = decision.tasks[0];
    if (position.source !== 'new') throw new Error('Expected a new task');
    const generated = Domain.generateLearningTask({
      specification: position.specification,
      knowledgePoint,
      sourceMaterials: [material],
    });
    expect(Domain.validateGeneratedTask(position.specification, generated)).toBe(true);
    const task = Domain.createLearningTask({
      id: 'task-1',
      learnerId: 'learner-1',
      specification: position.specification,
      generated,
      issuedAt: at.planned,
    });
    const planned = Domain.applyDailyStudyDecision(state, { planId: 'plan-1', decision, newTasks: [task], now: at.planned });
    const received = Domain.recordTaskAttempt(planned, {
      attemptId: 'attempt-1',
      taskId: task.id,
      submission: { task: 'ENCODE' },
      validity: { elapsedMs: 5000, interrupted: false },
      receivedAt: at.judged,
    });
    const judging = Domain.startTaskAttemptJudging(received.state, { attemptId: received.attempt.id });
    const judgement = Domain.judgeTask({ task, submission: received.attempt.submission, judgedAt: at.judged });
    const settled = Domain.settleTaskAttempt(judging.state, { attemptId: judging.attempt.id, judgement, now: at.judged });

    expect(settled.attempt.status).toBe('settled');
    expect(settled.state.tasks[0].status).toBe('completed');
    expect(settled.state.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(5);
    expect(validateLearningState(planned)).toEqual([]);
    expect(validateLearningState(received.state)).toEqual([]);
    expect(validateLearningState(judging.state)).toEqual([]);
    expect(validateLearningState(settled.state)).toEqual([]);

    const next = Domain.planDailyStudy(settled.state, {
      learnerId: 'learner-1',
      date: '2026-11-13',
      now: at.nextDay,
    });
    expect(next.tasks).toEqual([{
      source: 'new',
      specification: { goalId: 'goal-1', wordId: knowledgePoint.id, task: 'RETRIEVE', axis: 'R', stage: 'choice' },
    }]);
  });

  test('抽样可复现且遵守词段容量和每日零容量边界', () => {
    const input = { list, families, sampleCounts: { '1k': 1, '2k': 1 }, seed: 'repeatable' };
    expect(Domain.sampleVocabularyForAssessment(input)).toEqual(Domain.sampleVocabularyForAssessment(input));
    expect(() => Domain.sampleVocabularyForAssessment({ ...input, sampleCounts: { '2k': 2 } })).toThrow(RangeError);

    const { state } = buildInitializedState();
    const zeroCapacity: Model.LearningState = {
      ...state,
      learners: [{ ...state.learners[0], dailyTaskCapacity: 0 }],
    };
    const decision = Domain.planDailyStudy(zeroCapacity, {
      learnerId: 'learner-1',
      date: '2026-11-12',
      now: at.planned,
    });
    expect(decision.tasks).toEqual([]);
  });

  test('公开视图脱敏，重复定级作答和中断学习作答不会进入评判', () => {
    const { state } = buildInitializedState();
    const assessmentTask = state.vocabularyAssessmentTasks[0];
    const publicAssessment = Domain.toLearnerVocabularyAssessmentTask(assessmentTask);
    expect(publicAssessment).not.toHaveProperty('answerOptionId');
    expect(publicAssessment).not.toHaveProperty('knowledgePoint');
    const assessment: Extract<Model.VocabularyAssessment, { status: 'in_progress' }> = {
      ...state.vocabularyAssessments[0],
      status: 'in_progress',
      result: null,
      completedAt: null,
    };
    expect(() => Domain.recordVocabularyAssessmentAttempt({
      attemptId: 'assessment-attempt-2',
      assessment,
      task: assessmentTask,
      previousAttempts: state.vocabularyAssessmentAttempts,
      selectedOptionId: 'a',
      answeredAt: at.answered,
    })).toThrow('already been answered');

    const specification: Domain.TaskSpecification = {
      goalId: 'goal-1',
      wordId: state.knowledgePoints[0].id,
      task: 'RETRIEVE',
      axis: 'R',
      stage: 'choice',
    };
    const generated = Domain.generateLearningTask({
      specification,
      knowledgePoint: state.knowledgePoints[0],
      sourceMaterials: state.materials,
    });
    const task = Domain.createLearningTask({
      id: 'task-choice',
      learnerId: 'learner-1',
      specification,
      generated,
      issuedAt: at.planned,
    });
    const publicTask = Domain.toLearningTaskView(task);
    expect(publicTask.content.content).not.toHaveProperty('answerOptionId');
    expect(publicTask.content.content).not.toHaveProperty('explanation');
    const invalid = Domain.recordTaskAttempt({ ...state, tasks: [task] }, {
      attemptId: 'attempt-invalid',
      taskId: task.id,
      submission: { task: 'RETRIEVE', stage: 'choice', selectedOptionId: 'a' },
      validity: { elapsedMs: 1000, interrupted: true },
      receivedAt: at.judged,
    });
    expect(invalid.attempt.status).toBe('invalid');
    expect(() => Domain.startTaskAttemptJudging(invalid.state, { attemptId: invalid.attempt.id })).toThrow();
  });

  describe('decideNextTask', () => {
    const { state, knowledgePoint } = buildInitializedState();
    const goal = state.goals[0];
    const candidate = state.goalKnowledgePoints[0];
    const originalLearning = state.learnerKnowledgePoints[0];
    const baseSpecification = { goalId: goal.id, wordId: knowledgePoint.id };

    type DimensionInput = { fluency: number; dueAt?: string };

    function inputFor(learning: Model.LearnerKnowledgePoint | null): Domain.DecideNextTaskInput {
      return { goal, candidate, knowledgePoint, learning, now: at.planned };
    }

    function learningWith(r: DimensionInput, p: DimensionInput): Model.LearnerKnowledgePoint {
      const dimension = (input: DimensionInput): Model.DimensionLearningState => ({
        fluency: input.fluency,
        review: {
          ...originalLearning.dimensions.R.review,
          dueAt: input.dueAt ?? at.created,
        },
      });
      return {
        ...originalLearning,
        dimensions: { R: dimension(r), P: dimension(p) },
      };
    }

    test('没有学习状态时派发 ENCODE', () => {
      expect(Domain.decideNextTask(inputFor(null))).toEqual({
        ...baseSpecification,
        task: 'ENCODE',
      });
    });

    test.each([
      { fluency: 0, expected: { task: 'ENCODE' } },
      { fluency: 19, expected: { task: 'RETRIEVE', axis: 'R', stage: 'choice' } },
      { fluency: 20, expected: { task: 'RETRIEVE', axis: 'R', stage: 'cued' } },
      { fluency: 39, expected: { task: 'RETRIEVE', axis: 'R', stage: 'cued' } },
      { fluency: 40, expected: { task: 'RETRIEVE', axis: 'R', stage: 'free' } },
      { fluency: 59, expected: { task: 'RETRIEVE', axis: 'R', stage: 'free' } },
      { fluency: 60, expected: { task: 'FLUENCY', axis: 'R' } },
      { fluency: 99, expected: { task: 'FLUENCY', axis: 'R' } },
    ] as const)('流利度为 $fluency 时派发 $expected.task', ({ fluency, expected }) => {
      const learning = learningWith({ fluency }, { fluency: 100 });
      expect(Domain.decideNextTask(inputFor(learning))).toEqual({
        ...baseSpecification,
        ...expected,
      });
    });

    test.each([
      {
        name: 'R/P 都已达目标',
        r: { fluency: 100, dueAt: at.created },
        p: { fluency: 100, dueAt: at.created },
      },
      {
        name: 'R/P 都尚未到复习时间',
        r: { fluency: 50, dueAt: at.nextDay },
        p: { fluency: 50, dueAt: at.nextDay },
      },
    ])('$name时不派发任务', ({ r, p }) => {
      expect(Domain.decideNextTask(inputFor(learningWith(r, p)))).toBeNull();
    });

    test('优先选择复习到期更早的维度', () => {
      const learning = learningWith(
        { fluency: 50, dueAt: at.answered },
        { fluency: 50, dueAt: at.created },
      );
      expect(Domain.decideNextTask(inputFor(learning))).toEqual({
        ...baseSpecification,
        task: 'RETRIEVE',
        axis: 'P',
        stage: 'free',
      });
    });

    test('复习到期时间相同时优先选择 R', () => {
      const learning = learningWith(
        { fluency: 50, dueAt: at.answered },
        { fluency: 50, dueAt: at.answered },
      );
      expect(Domain.decideNextTask(inputFor(learning))).toEqual({
        ...baseSpecification,
        task: 'RETRIEVE',
        axis: 'R',
        stage: 'free',
      });
    });

    test('已达目标的维度不参与任务选择', () => {
      const learning = learningWith({ fluency: 100 }, { fluency: 50 });
      expect(Domain.decideNextTask(inputFor(learning))).toEqual({
        ...baseSpecification,
        task: 'RETRIEVE',
        axis: 'P',
        stage: 'free',
      });
    });
  });
});
