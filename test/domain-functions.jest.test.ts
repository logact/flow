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

  test('公开自评视图脱敏，重复定级作答和中断学习作答不会进入评判', () => {
    const { state } = buildInitializedState();
    const assessmentTask = state.vocabularyAssessmentTasks[0];
    const publicAssessment = Domain.toLearnerVocabularyAssessmentTask(assessmentTask);
    expect(publicAssessment).toEqual({
      id: assessmentTask.id,
      band: assessmentTask.band,
      knowledgePointId: assessmentTask.knowledgePoint.id,
      lemma: assessmentTask.knowledgePoint.lemma,
    });
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
      known: true,
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

    type DimensionInput = { fluency: number; dueAt?: string; graduated?: boolean };

    function inputFor(learning: Model.LearnerKnowledgePoint | null): Domain.DecideNextTaskInput {
      return { goal, candidate, knowledgePoint, learning, now: at.planned };
    }

    function learningWith(r: DimensionInput, p: DimensionInput): Model.LearnerKnowledgePoint {
      const dimension = (input: DimensionInput): Model.DimensionLearningState => ({
        fluency: input.fluency,
        review: {
          ...originalLearning.dimensions.R.review,
          dueAt: input.dueAt ?? at.created,
          graduated: input.graduated ?? false,
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
        name: 'R/P 都已毕业',
        r: { fluency: 100, dueAt: at.created, graduated: true },
        p: { fluency: 100, dueAt: at.created, graduated: true },
      },
      {
        name: 'R/P 都尚未到复习时间',
        r: { fluency: 50, dueAt: at.nextDay },
        p: { fluency: 50, dueAt: at.nextDay },
      },
    ])('$name时不派发任务', ({ r, p }) => {
      expect(Domain.decideNextTask(inputFor(learningWith(r, p)))).toBeNull();
    });

    test('达到目标但未毕业时仍派发 FLUENCY 复习', () => {
      const learning = learningWith({ fluency: 100 }, { fluency: 100 });
      expect(Domain.decideNextTask(inputFor(learning))).toEqual({
        ...baseSpecification,
        task: 'FLUENCY',
        axis: 'R',
      });
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

    test('已毕业的维度不参与任务选择', () => {
      const learning = learningWith({ fluency: 100, graduated: true }, { fluency: 50 });
      expect(Domain.decideNextTask(inputFor(learning))).toEqual({
        ...baseSpecification,
        task: 'RETRIEVE',
        axis: 'P',
        stage: 'free',
      });
    });
  });

  describe('达标后复习与毕业', () => {
    const currentReview: Model.ReviewSchedule = {
      intervalDays: 30,
      dueAt: at.planned,
      lastReviewedAt: at.answered,
      successfulReviewStreak: 3,
      lapseCount: 0,
      graduated: false,
    };

    test('达到目标时重新从一天后的首次复习开始', () => {
      const review = Domain.calculateNextReviewSchedule({
        current: currentReview,
        nextFluency: 100,
        judgement: { outcome: 'correct', score: 1 },
        reviewedAt: at.planned,
        review: false,
        targetReached: true,
      });
      expect(review).toMatchObject({
        intervalDays: 1,
        dueAt: '2026-11-13T00:30:00.000Z',
        successfulReviewStreak: 1,
        graduated: false,
      });
    });

    test('通过最后一次 30 天间隔复习后才毕业', () => {
      const review = Domain.calculateNextReviewSchedule({
        current: currentReview,
        nextFluency: 100,
        judgement: { outcome: 'correct', score: 1 },
        reviewedAt: at.planned,
        review: true,
        targetReached: false,
      });
      expect(review).toMatchObject({ graduated: true, dueAt: currentReview.dueAt });
    });

    test('达标结算后的下一次排期是 FLUENCY 复习', () => {
      const initialized = buildInitializedState();
      const state: Model.LearningState = {
        ...initialized.state,
        goals: [{ ...initialized.state.goals[0], targetFluency: { R: 5, P: 5 } }],
      };
      const decision = Domain.planDailyStudy(state, {
        learnerId: 'learner-1',
        date: '2026-11-12',
        now: at.planned,
      });
      const position = decision.tasks[0];
      if (position.source !== 'new') throw new Error('Expected a new task');
      const generated = Domain.generateLearningTask({
        specification: position.specification,
        knowledgePoint: initialized.knowledgePoint,
        sourceMaterials: [initialized.material],
      });
      const task = Domain.createLearningTask({
        id: 'task-target-review',
        learnerId: 'learner-1',
        specification: position.specification,
        generated,
        issuedAt: at.planned,
      });
      const planned = Domain.applyDailyStudyDecision(state, {
        planId: 'plan-target-review',
        decision,
        newTasks: [task],
        now: at.planned,
      });
      const received = Domain.recordTaskAttempt(planned, {
        attemptId: 'attempt-target-review',
        taskId: task.id,
        submission: { task: 'ENCODE' },
        validity: { elapsedMs: 5000, interrupted: false },
        receivedAt: at.judged,
      });
      const judging = Domain.startTaskAttemptJudging(received.state, { attemptId: received.attempt.id });
      const judgement = Domain.judgeTask({ task, submission: received.attempt.submission, judgedAt: at.judged });
      const settled = Domain.settleTaskAttempt(judging.state, {
        attemptId: judging.attempt.id,
        judgement,
        now: at.judged,
      });
      expect(settled.state.learnerKnowledgePoints[0].dimensions.R.review).toMatchObject({
        intervalDays: 1,
        graduated: false,
      });
      const next = Domain.planDailyStudy(settled.state, {
        learnerId: 'learner-1',
        date: '2026-11-13',
        now: at.nextDay,
      });
      expect(next.tasks).toEqual([{
        source: 'new',
        specification: { goalId: 'goal-1', wordId: initialized.knowledgePoint.id, task: 'FLUENCY', axis: 'R' },
      }]);
    });
  });

  describe('旧版流利度计分', () => {
    const initialized = buildInitializedState();
    const base = { goalId: 'goal-1', wordId: initialized.knowledgePoint.id };

    function makeTask(specification: Domain.TaskSpecification): Model.LearningTask {
      const generated = Domain.generateLearningTask({
        specification,
        knowledgePoint: initialized.knowledgePoint,
        sourceMaterials: [initialized.material],
      });
      return Domain.createLearningTask({
        id: 'task-old-scoring',
        learnerId: 'learner-1',
        specification,
        generated,
        issuedAt: at.planned,
      });
    }

    function correctJudgement(overrides: Partial<Model.DimensionJudgement> = {}): Model.DimensionJudgement {
      return { outcome: 'correct', score: 1, ...overrides };
    }

    test('ENCODE 完成时至少达到 5，未完成时保持原分', () => {
      const task = makeTask({ ...base, task: 'ENCODE' });
      expect(Domain.calculateNextFluency({
        task,
        dimension: 'R',
        currentFluency: 0,
        judgement: correctJudgement(),
      })).toBe(5);
      expect(Domain.calculateNextFluency({
        task,
        dimension: 'R',
        currentFluency: 7,
        judgement: correctJudgement(),
      })).toBe(7);
      expect(Domain.calculateNextFluency({
        task,
        dimension: 'R',
        currentFluency: 7,
        judgement: { outcome: 'incorrect', score: 0 },
      })).toBe(7);
    });

    test.each([
      { stage: 'choice', outcome: 'correct', expected: 20 },
      { stage: 'choice', outcome: 'incorrect', expected: 5 },
      { stage: 'cued', outcome: 'correct', expected: 40 },
      { stage: 'cued', outcome: 'incorrect', expected: 5 },
      { stage: 'free', outcome: 'correct', expected: 60 },
      { stage: 'free', outcome: 'incorrect', expected: 20 },
    ] as const)('RETRIEVE $stage $outcome 时设为 $expected', ({ stage, outcome, expected }) => {
      const task = makeTask({ ...base, task: 'RETRIEVE', axis: 'R', stage });
      expect(Domain.calculateNextFluency({
        task,
        dimension: 'R',
        currentFluency: 25,
        judgement: { outcome, score: outcome === 'correct' ? 1 : 0 },
      })).toBe(expected);
    });

    test('RETRIEVE partial 按失败赋分', () => {
      const task = makeTask({ ...base, task: 'RETRIEVE', axis: 'R', stage: 'cued' });
      expect(Domain.calculateNextFluency({
        task,
        dimension: 'R',
        currentFluency: 25,
        judgement: { outcome: 'partial', score: 0.5 },
      })).toBe(5);
    });

    test.each([
      { axis: 'R', speedWpm: 150, expected: 60 },
      { axis: 'R', speedWpm: 225, expected: 80 },
      { axis: 'R', speedWpm: 300, expected: 100 },
      { axis: 'P', speedWpm: 25, expected: 60 },
      { axis: 'P', speedWpm: 42.5, expected: 80 },
      { axis: 'P', speedWpm: 60, expected: 100 },
    ] as const)('FLUENCY $axis 速度为 $speedWpm 时设为 $expected', ({ axis, speedWpm, expected }) => {
      const task = makeTask({ ...base, task: 'FLUENCY', axis });
      expect(Domain.calculateNextFluency({
        task,
        dimension: axis,
        currentFluency: 75,
        judgement: correctJudgement({ targetPassed: true, overallPassed: true, speedWpm }),
      })).toBeCloseTo(expected);
    });

    test('FLUENCY 目标失败、整体失败、低速和无效速度遵循旧版规则', () => {
      const task = makeTask({ ...base, task: 'FLUENCY', axis: 'R' });
      const calculate = (judgement: Model.DimensionJudgement) => Domain.calculateNextFluency({
        task,
        dimension: 'R',
        currentFluency: 77,
        judgement,
      });
      expect(calculate(correctJudgement({ targetPassed: false, overallPassed: true, speedWpm: 225 }))).toBe(40);
      expect(calculate(correctJudgement({ targetPassed: true, overallPassed: false, speedWpm: 225 }))).toBe(77);
      expect(calculate(correctJudgement({ targetPassed: true, overallPassed: true, speedWpm: 149 }))).toBe(40);
      expect(calculate(correctJudgement({ targetPassed: true, overallPassed: true, speedWpm: 0 }))).toBe(77);
      expect(() => calculate(correctJudgement({ targetPassed: true, overallPassed: true }))).toThrow('speedWpm');
    });

    test('规则评判生成 R/P 的目标、整体和速度证据', () => {
      const readingTask = makeTask({ ...base, task: 'FLUENCY', axis: 'R' });
      if (readingTask.content.task !== 'FLUENCY' || readingTask.content.content.axis !== 'R') {
        throw new Error('Expected reading task');
      }
      const answers: Model.ReadingQuestionSubmission[] = readingTask.content.content.questions.map((question) =>
        question.kind === 'choice'
          ? { questionId: question.id, kind: 'choice', selectedOptionId: question.answerOptionId }
          : { questionId: question.id, kind: 'free', answer: question.answer });
      const reading = Domain.judgeTask({
        task: readingTask,
        submission: { task: 'FLUENCY', axis: 'R', readingElapsedMs: 60000, answers },
        judgedAt: at.judged,
      });
      expect(reading.dimensions.R).toMatchObject({ targetPassed: true, overallPassed: true, speedWpm: 4 });

      const productionTask = makeTask({ ...base, task: 'FLUENCY', axis: 'P' });
      const production = Domain.judgeTask({
        task: productionTask,
        submission: { task: 'FLUENCY', axis: 'P', response: 'I run every morning.' },
        judgedAt: at.judged,
        elapsedMs: 60000,
      });
      expect(production.dimensions.P).toMatchObject({ targetPassed: true, overallPassed: true, speedWpm: 4 });
    });

    test('FLUENCY 评判证据进入真实结算并更新为公式分数', () => {
      const task = makeTask({ ...base, task: 'FLUENCY', axis: 'R' });
      if (task.content.task !== 'FLUENCY' || task.content.content.axis !== 'R') {
        throw new Error('Expected reading task');
      }
      const originalLearning = initialized.state.learnerKnowledgePoints[0];
      const state: Model.LearningState = {
        ...initialized.state,
        learnerKnowledgePoints: [{
          ...originalLearning,
          dimensions: {
            R: { ...originalLearning.dimensions.R, fluency: 75 },
            P: {
              ...originalLearning.dimensions.P,
              fluency: 100,
              review: { ...originalLearning.dimensions.P.review, graduated: true },
            },
          },
        }],
        tasks: [task],
      };
      const answers: Model.ReadingQuestionSubmission[] = task.content.content.questions.map((question) =>
        question.kind === 'choice'
          ? { questionId: question.id, kind: 'choice', selectedOptionId: question.answerOptionId }
          : { questionId: question.id, kind: 'free', answer: question.answer });
      const received = Domain.recordTaskAttempt(state, {
        attemptId: 'attempt-old-scoring',
        taskId: task.id,
        submission: { task: 'FLUENCY', axis: 'R', readingElapsedMs: 1000, answers },
        validity: { elapsedMs: 1000, interrupted: false },
        receivedAt: at.judged,
      });
      const judging = Domain.startTaskAttemptJudging(received.state, { attemptId: received.attempt.id });
      const settled = Domain.settleTaskAttempt(judging.state, {
        attemptId: judging.attempt.id,
        judgement: {
          taskId: task.id,
          dimensions: { R: correctJudgement({ targetPassed: true, overallPassed: true, speedWpm: 225 }) },
          feedback: 'Correct',
          judgedBy: 'rule',
          judgedAt: at.judged,
        },
        now: at.judged,
      });
      expect(settled.state.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(80);
    });
  });

  describe('结算后的当日重排', () => {
    function buildReplanState(reviewDueAt: Model.ISODateTime = at.nextDay) {
      const initialized = buildInitializedState();
      const newA = initialized.knowledgePoint;
      const newB: Model.KnowledgePoint = {
        ...newA,
        id: 'kp-new-b',
        sense: { ...newA.sense, id: 'sense-new-b' },
      };
      const review: Model.KnowledgePoint = {
        ...newA,
        id: 'kp-review',
        sense: { ...newA.sense, id: 'sense-review' },
      };
      const originalLearning = initialized.state.learnerKnowledgePoints[0];
      const unstartedLearning = (knowledgePointId: string): Model.LearnerKnowledgePoint => ({
        ...originalLearning,
        knowledgePointId,
        initialization: { ...originalLearning.initialization, classification: null },
        dimensions: {
          R: { fluency: 20, review: { ...originalLearning.dimensions.R.review, dueAt: at.planned } },
          P: { fluency: 20, review: { ...originalLearning.dimensions.P.review, dueAt: at.nextDay } },
        },
      });
      const reviewLearning: Model.LearnerKnowledgePoint = {
        ...unstartedLearning(review.id),
        dimensions: {
          R: {
            fluency: 50,
            review: {
              ...originalLearning.dimensions.R.review,
              dueAt: reviewDueAt,
              lastReviewedAt: at.answered,
            },
          },
          P: {
            fluency: 100,
            review: {
              ...originalLearning.dimensions.P.review,
              dueAt: at.nextDay,
              lastReviewedAt: at.answered,
              graduated: true,
            },
          },
        },
      };
      const specification: Domain.TaskSpecification = {
        goalId: 'goal-1',
        wordId: newA.id,
        task: 'RETRIEVE',
        axis: 'R',
        stage: 'choice',
      };
      const makeTask = (id: string, knowledgePoint: Model.KnowledgePoint): Model.LearningTask => {
        const taskSpecification = { ...specification, wordId: knowledgePoint.id };
        const generated = Domain.generateLearningTask({
          specification: taskSpecification,
          knowledgePoint,
          sourceMaterials: [initialized.material],
        });
        return Domain.createLearningTask({
          id,
          learnerId: 'learner-1',
          specification: taskSpecification,
          generated,
          issuedAt: at.planned,
        });
      };
      const taskA = makeTask('task-new-a', newA);
      const taskB = makeTask('task-new-b', newB);
      const state: Model.LearningState = {
        ...initialized.state,
        learners: [{ ...initialized.state.learners[0], dailyTaskCapacity: 2 }],
        knowledgePoints: [newA, newB, review],
        goalKnowledgePoints: [newA, newB, review].map((knowledgePoint) => ({
          ...initialized.state.goalKnowledgePoints[0],
          knowledgePointId: knowledgePoint.id,
        })),
        learnerKnowledgePoints: [
          unstartedLearning(newA.id),
          unstartedLearning(newB.id),
          reviewLearning,
        ],
        studyPlans: [{
          id: 'plan-1',
          learnerId: 'learner-1',
          date: '2026-11-12',
          taskCapacity: 2,
          taskIds: [taskA.id, taskB.id],
          createdAt: at.planned,
          updatedAt: at.planned,
        }],
        tasks: [taskA, taskB],
      };
      return { state, newA, newB, review, taskA, taskB };
    }

    function settleChoiceAnswer(state: Model.LearningState, task: Model.LearningTask, selectedOptionId: string) {
      const received = Domain.recordTaskAttempt(state, {
        attemptId: `attempt-${task.id}`,
        taskId: task.id,
        submission: { task: 'RETRIEVE', stage: 'choice', selectedOptionId },
        validity: { elapsedMs: 5000, interrupted: false },
        receivedAt: at.judged,
      });
      const judging = Domain.startTaskAttemptJudging(received.state, { attemptId: received.attempt.id });
      const judgement = Domain.judgeTask({
        task,
        submission: received.attempt.submission,
        judgedAt: at.judged,
      });
      return Domain.settleTaskAttempt(judging.state, {
        attemptId: judging.attempt.id,
        judgement,
        now: at.judged,
      });
    }

    test('答错产生到期复习时取消尚未开始的新词任务', () => {
      const { state, newA, newB, review, taskA, taskB } = buildReplanState(at.planned);
      const settled = settleChoiceAnswer(state, taskA, 'b');
      expect(settled.attempt.judgement.dimensions.R?.outcome).toBe('incorrect');
      expect(validateLearningState(settled.state)).toEqual([]);

      const decision = Domain.planDailyStudy(settled.state, {
        learnerId: 'learner-1',
        date: '2026-11-12',
        now: at.judged,
      });
      expect(decision.tasks).toEqual([
        {
          source: 'new',
          specification: { goalId: 'goal-1', wordId: review.id, task: 'RETRIEVE', axis: 'R', stage: 'free' },
        },
        {
          source: 'new',
          specification: { goalId: 'goal-1', wordId: newA.id, task: 'RETRIEVE', axis: 'R', stage: 'choice' },
        },
      ]);
      expect(decision.cancelTaskIds).toEqual([taskB.id]);

      const knowledgePoints = new Map([newA, newB, review].map((item) => [item.id, item]));
      const newTasks = decision.tasks.map((position, index) => {
        if (position.source !== 'new') throw new Error('Expected a new task');
        const knowledgePoint = knowledgePoints.get(position.specification.wordId)!;
        const generated = Domain.generateLearningTask({
          specification: position.specification,
          knowledgePoint,
          sourceMaterials: state.materials,
        });
        return Domain.createLearningTask({
          id: `task-replanned-${index}`,
          learnerId: 'learner-1',
          specification: position.specification,
          generated,
          issuedAt: at.judged,
        });
      });
      const replanned = Domain.applyDailyStudyDecision(settled.state, {
        decision,
        newTasks,
        now: at.judged,
      });
      expect(replanned.tasks.find((task) => task.id === taskB.id)?.status).toBe('cancelled');
      expect(replanned.studyPlans[0].taskIds).toEqual(['task-replanned-0', 'task-replanned-1']);
      expect(validateLearningState(replanned)).toEqual([]);
    });

    test('答对后不产生当天重试并保留其他新词任务', () => {
      const { state, taskA, taskB } = buildReplanState();
      const settled = settleChoiceAnswer(state, taskA, 'a');
      expect(settled.attempt.judgement.dimensions.R?.outcome).toBe('correct');

      const decision = Domain.planDailyStudy(settled.state, {
        learnerId: 'learner-1',
        date: '2026-11-12',
        now: at.judged,
      });
      expect(decision.tasks).toEqual([{ source: 'existing', taskId: taskB.id }]);
      expect(decision.cancelTaskIds).toEqual([]);
    });
  });

  describe('新词未来容量准入', () => {
    const planInput = {
      learnerId: 'learner-1',
      date: '2026-11-12',
      now: at.planned,
    };

    interface CapacityStateOptions {
      capacity: number;
      existingCount: number;
      newWords: Array<{ id: string; band?: Model.VocabularyBand }>;
      existingDueAt?: string;
    }

    function capacityState(options: CapacityStateOptions): Model.LearningState {
      const initialized = buildInitializedState();
      const existingIds = Array.from({ length: options.existingCount }, (_, index) => `existing-${index}`);
      const ids = [...existingIds, ...options.newWords.map((word) => word.id)];
      const originalLearning = initialized.state.learnerKnowledgePoints[0];
      const vocabulary = initialized.state.learners[0].currentVocabulary!;
      const commonBand: Model.VocabularyBandEstimate = {
        band: '1k',
        wordFamilyCount: 1000,
        sampleCount: 1,
        knownCount: 1,
        knownProbability: 1,
        interval: null,
      };
      const bands = options.newWords.some((word) => word.band === '1k')
        ? [...vocabulary.bands, commonBand]
        : vocabulary.bands;
      const knowledgePointVocabularyClassifications: Model.KnowledgePointVocabularyClassification[] = ids.map((id) => ({
        ...initialized.state.knowledgePointVocabularyClassifications[0],
        knowledgePointId: id,
        band: options.newWords.find((word) => word.id === id)?.band ?? '2k',
      }));
      const learnerKnowledgePoints: Model.LearnerKnowledgePoint[] = existingIds.map((id) => {
        const dimension = (fluency: number, graduated = false): Model.DimensionLearningState => ({
          fluency,
          review: {
            ...originalLearning.dimensions.R.review,
            dueAt: options.existingDueAt ?? at.nextDay,
            graduated,
          },
        });
        return {
          ...originalLearning,
          knowledgePointId: id,
          initialization: {
            ...originalLearning.initialization,
            classification: originalLearning.initialization.classification
              ? { ...originalLearning.initialization.classification, knowledgePointId: id }
              : null,
          },
          dimensions: { R: dimension(98), P: dimension(100, true) },
        };
      });
      return {
        ...emptyState(),
        learners: [{
          ...initialized.state.learners[0],
          dailyTaskCapacity: options.capacity,
          currentVocabulary: { ...vocabulary, bands },
        }],
        goals: initialized.state.goals,
        knowledgePoints: ids.map((id) => ({ ...initialized.knowledgePoint, id })),
        knowledgePointVocabularyClassifications,
        goalKnowledgePoints: ids.map((id) => ({
          ...initialized.state.goalKnowledgePoints[0],
          knowledgePointId: id,
        })),
        learnerKnowledgePoints,
      };
    }

    test('未来到期容量不足时拒绝新词，刚好容纳时准入', () => {
      const options = { existingCount: 2, newWords: [{ id: 'new-a' }] };
      const blockedState = capacityState({ ...options, capacity: 3 });
      const admittedState = capacityState({ ...options, capacity: 4 });
      expect(validateLearningState(blockedState)).toEqual([]);
      expect(validateLearningState(admittedState)).toEqual([]);
      expect(Domain.planDailyStudy(blockedState, planInput).tasks).toEqual([]);
      expect(Domain.planDailyStudy(admittedState, planInput).tasks).toEqual([{
        source: 'new',
        specification: { goalId: 'goal-1', wordId: 'new-a', task: 'ENCODE' },
      }]);
    });

    test('多个新词依次占用未来容量，首个无法容纳的新词不再引入', () => {
      const state = capacityState({
        capacity: 4,
        existingCount: 2,
        newWords: [{ id: 'new-a', band: '2k' }, { id: 'new-b', band: '1k' }],
      });
      expect(Domain.planDailyStudy(state, planInput).tasks).toEqual([{
        source: 'new',
        specification: { goalId: 'goal-1', wordId: 'new-a', task: 'ENCODE' },
      }]);
    });

    test('容量预测包含第 41 天但不包含第 42 天', () => {
      const options = { capacity: 2, existingCount: 1, newWords: [{ id: 'new-a' }] };
      const inside = capacityState({ ...options, existingDueAt: '2026-12-23T00:30:00.000Z' });
      const outside = capacityState({ ...options, existingDueAt: '2026-12-24T00:30:00.000Z' });
      expect(Domain.planDailyStudy(inside, planInput).tasks).toEqual([]);
      expect(Domain.planDailyStudy(outside, planInput).tasks).toEqual([{
        source: 'new',
        specification: { goalId: 'goal-1', wordId: 'new-a', task: 'ENCODE' },
      }]);
    });
  });
});
