/// <reference types="jest" />

/**
 * 核心流程的接口契约模拟，不是业务算法测试。
 * 除 validateLearningState 真实执行外，所有领域函数均使用 Jest 桩和预置结果。
 * 因此本文件可以确认参数、返回结构和状态约束能够衔接，不能确认业务实现正确。
 */

import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import type * as Domain from '../lib/domain/functions';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';

const list: Model.VocabularyListReference = { id: 'bnc-coca-l6', version: '2.0.0' };
// 词族来自仓库现有词表夹具，不在测试中凭空指定词频来源。
const wordFamilies: Domain.VocabularyAssessmentWordFamily[] = vocabularyFixture.families.map((family) => ({
  ...family,
  band: family.band as Model.VocabularyBand,
}));
const runFamily = wordFamilies.find((family) => family.id === 'fixture-2');
if (!runFamily) throw new Error('词表夹具缺少 run 词族');
// 这是 sampleVocabularyForAssessment 的预置输出，内容直接来源于 runFamily。
const assessmentSample: Domain.VocabularyAssessmentSample = {
  familyId: runFamily.id,
  band: runFamily.band,
  lemma: runFamily.headword,
  wordFamily: runFamily.headword,
};
const at = {
  created: '2026-11-12T00:00:00.000Z',
  assessed: '2026-11-12T00:10:00.000Z',
  analyzed: '2026-11-12T00:20:00.000Z',
  planned: '2026-11-12T00:30:00.000Z',
  judged: '2026-11-12T00:40:00.000Z',
  nextDay: '2026-11-13T00:30:00.000Z',
};

const knowledgePoint: Model.KnowledgePoint = {
  id: 'kp-run',
  kind: 'word',
  lemma: assessmentSample.lemma,
  wordFamily: assessmentSample.wordFamily,
  sense: {
    id: 'sense-run',
    definition: 'to move quickly',
    partOfSpeech: 'verb',
    explanation: null,
  },
};

const classification: Model.KnowledgePointVocabularyClassification = {
  knowledgePointId: knowledgePoint.id,
  list,
  band: assessmentSample.band,
};

// 这是 generateVocabularyAssessmentTasks 的预置输出，不是真实生成器计算结果。
const assessmentTask: Model.VocabularyAssessmentTask = {
  id: 'assessment-task-1',
  band: assessmentSample.band,
  knowledgePoint,
};

const publicAssessmentTask: Model.LearnerVocabularyAssessmentTask = {
  id: assessmentTask.id,
  band: assessmentTask.band,
  knowledgePointId: knowledgePoint.id,
  lemma: assessmentTask.knowledgePoint.lemma,
};

const vocabulary: Model.VocabularyEstimate = {
  list,
  bands: [{
    band: '2k',
    wordFamilyCount: 2000,
    knownProbability: 0.8,
    sampleCount: 1,
    knownCount: 1,
    interval: null,
  }],
  estimatedAt: at.assessed,
};

const initialLearner: Model.Learner = {
  id: 'learner-1',
  currentVocabulary: null,
  dailyTaskCapacity: 3,
  timezone: 'Asia/Shanghai',
  createdAt: at.created,
  updatedAt: at.created,
};

const assessedLearner: Model.Learner = {
  ...initialLearner,
  currentVocabulary: vocabulary,
  updatedAt: at.assessed,
};

const inProgressAssessment: Extract<Model.VocabularyAssessment, { status: 'in_progress' }> = {
  id: 'assessment-1',
  learnerId: initialLearner.id,
  taskIds: [assessmentTask.id],
  status: 'in_progress',
  result: null,
  createdAt: at.created,
  completedAt: null,
};

const assessmentAttempt: Model.VocabularyAssessmentAttempt = {
  id: 'assessment-attempt-1',
  assessmentId: inProgressAssessment.id,
  taskId: assessmentTask.id,
  known: true,
  answeredAt: at.assessed,
};

const completedAssessment: Extract<Model.VocabularyAssessment, { status: 'completed' }> = {
  ...inProgressAssessment,
  status: 'completed',
  result: vocabulary,
  completedAt: at.assessed,
};

const material: Model.Material = {
  id: 'material-1',
  learnerId: initialLearner.id,
  title: 'Morning run',
  filename: 'morning-run.md',
  format: 'markdown',
  mimeType: 'text/markdown',
  checksum: 'checksum-1',
  storageKey: null,
  extractedText: 'I run every morning.',
  extractionMetadata: { extractor: 'fixture' },
  createdAt: at.analyzed,
};

const analysis: Extract<Model.MaterialAnalysis, { status: 'analyzed' }> = {
  id: 'analysis-1',
  materialId: material.id,
  analyzerVersion: 'fixture-v1',
  status: 'analyzed',
  items: [{
    knowledgePoint,
    occurrences: [{ rawForm: 'run', sentence: 'I run every morning.', context: [] }],
  }],
  unmatchedItems: [],
  errors: [],
  createdAt: at.analyzed,
  completedAt: at.analyzed,
};

const goal: Model.LearningGoal = {
  id: 'goal-1',
  learnerId: initialLearner.id,
  title: 'Core vocabulary',
  targetFluency: { R: 80, P: 80 },
  status: 'active',
  createdAt: at.analyzed,
  updatedAt: at.analyzed,
};

const undecidedCandidate: Model.GoalKnowledgePoint = {
  goalId: goal.id,
  knowledgePointId: knowledgePoint.id,
  selection: 'undecided',
  addedAt: at.analyzed,
  selectionUpdatedAt: at.analyzed,
};

const includedCandidate: Model.GoalKnowledgePoint = {
  ...undecidedCandidate,
  selection: 'included',
  selectionUpdatedAt: at.analyzed,
};

const materialLink: Model.GoalMaterial = {
  goalId: goal.id,
  materialId: material.id,
  analysisId: analysis.id,
  addedAt: at.analyzed,
};

const source: Model.GoalKnowledgePointSource = {
  goalId: goal.id,
  knowledgePointId: knowledgePoint.id,
  sourceAnalysisId: analysis.id,
  addedAt: at.analyzed,
};

const initialReview: Model.ReviewSchedule = {
  intervalDays: 0,
  dueAt: at.planned,
  lastReviewedAt: null,
  successfulReviewStreak: 0,
  lapseCount: 0,
  graduated: false,
};

const learning: Model.LearnerKnowledgePoint = {
  learnerId: initialLearner.id,
  knowledgePointId: knowledgePoint.id,
  initialFluency: { R: 20, P: 16 },
  initialization: {
    sourceVocabulary: vocabulary,
    classification,
    policyVersion: 'initial-v1',
    productionBasis: 'derived_from_receptive',
  },
  dimensions: {
    R: { fluency: 20, review: initialReview },
    P: { fluency: 16, review: initialReview },
  },
  createdAt: at.analyzed,
  updatedAt: at.analyzed,
  version: 0,
};

const specification: Domain.TaskSpecification = {
  goalId: goal.id,
  wordId: knowledgePoint.id,
  task: 'RETRIEVE',
  axis: 'R',
  stage: 'choice',
};

// 这是 generateLearningTask 的预置输出，不是真实生成器计算结果。
const generated: Model.GeneratedTask = {
  schemaVersion: '1',
  task: 'RETRIEVE',
  wordId: knowledgePoint.id,
  content: {
    axis: 'R',
    stage: 'choice',
    prompt: 'What does run mean?',
    options: [
      { id: 'a', text: '快速移动' },
      { id: 'b', text: '保持静止' },
    ],
    answerOptionId: 'a',
    explanation: 'Run means to move quickly.',
  },
};

const issuedTask: Model.LearningTask = {
  id: 'task-1',
  learnerId: initialLearner.id,
  goalId: goal.id,
  issuedAt: at.planned,
  status: 'issued',
  completedAt: null,
  content: generated,
};

const taskView: Model.LearningTaskView = {
  ...issuedTask,
  content: {
    ...generated,
    content: {
      axis: 'R',
      stage: 'choice',
      prompt: 'What does run mean?',
      options: generated.content.options,
    },
  },
};

const submission: Model.TaskSubmission = {
  task: 'RETRIEVE',
  stage: 'choice',
  selectedOptionId: 'a',
};

const judgement: Model.TaskJudgement = {
  taskId: issuedTask.id,
  dimensions: { R: { outcome: 'correct', score: 1 } },
  feedback: 'Correct',
  judgedBy: 'rule',
  judgedAt: at.judged,
};

const nextReview: Model.ReviewSchedule = {
  intervalDays: 1,
  dueAt: at.nextDay,
  lastReviewedAt: at.judged,
  successfulReviewStreak: 1,
  lapseCount: 0,
  graduated: false,
};

const updatedVocabulary: Model.VocabularyEstimate = {
  ...vocabulary,
  estimatedAt: at.judged,
};

const settledLearning: Model.LearnerKnowledgePoint = {
  ...learning,
  dimensions: {
    ...learning.dimensions,
    R: { fluency: 22, review: nextReview },
  },
  updatedAt: at.judged,
  version: 1,
};

const stateBeforePlanning: Model.LearningState = {
  learners: [assessedLearner],
  vocabularyAssessments: [completedAssessment],
  vocabularyAssessmentTasks: [assessmentTask],
  vocabularyAssessmentAttempts: [assessmentAttempt],
  materials: [material],
  materialAnalyses: [analysis],
  goals: [goal],
  goalMaterials: [materialLink],
  knowledgePoints: [knowledgePoint],
  knowledgePointVocabularyClassifications: [classification],
  goalKnowledgePoints: [includedCandidate],
  goalKnowledgePointSources: [source],
  learnerKnowledgePoints: [learning],
  studyPlans: [],
  tasks: [],
  attempts: [],
};

const decision: Domain.DailyStudyDecision = {
  learnerId: initialLearner.id,
  date: '2026-11-12',
  taskCapacity: initialLearner.dailyTaskCapacity,
  tasks: [{ source: 'new', specification }],
  expireTaskIds: [],
  cancelTaskIds: [],
};

const studyPlan: Model.DailyStudyPlan = {
  id: 'plan-1',
  learnerId: initialLearner.id,
  date: decision.date,
  taskCapacity: decision.taskCapacity,
  taskIds: [issuedTask.id],
  createdAt: at.planned,
  updatedAt: at.planned,
};

const stateWithTask: Model.LearningState = {
  ...stateBeforePlanning,
  studyPlans: [studyPlan],
  tasks: [issuedTask],
};

const attemptBase = {
  id: 'attempt-1',
  taskId: issuedTask.id,
  learnerId: initialLearner.id,
  submission,
  validity: { elapsedMs: 5000, interrupted: false },
  receivedAt: at.judged,
};

const receivedAttempt: Extract<Model.TaskAttempt, { status: 'received' }> = {
  ...attemptBase,
  status: 'received',
  judgement: null,
  settlement: null,
  statusReason: null,
};

const judgingAttempt: Extract<Model.TaskAttempt, { status: 'judging' }> = {
  ...receivedAttempt,
  status: 'judging',
};

const stateAfterReceipt: Model.LearningState = {
  ...stateWithTask,
  attempts: [receivedAttempt],
};

const stateWhileJudging: Model.LearningState = {
  ...stateWithTask,
  attempts: [judgingAttempt],
};

const settledAttempt: Extract<Model.TaskAttempt, { status: 'settled' }> = {
  ...attemptBase,
  status: 'settled',
  judgement,
  settlement: {
    fluencyChanges: [{
      knowledgePointId: knowledgePoint.id,
      dimension: 'R',
      before: 20,
      after: 22,
    }],
    reviewChanges: [{
      knowledgePointId: knowledgePoint.id,
      dimension: 'R',
      before: initialReview,
      after: nextReview,
    }],
    vocabularyBefore: vocabulary,
    vocabularyAfter: updatedVocabulary,
    settledAt: at.judged,
  },
  statusReason: null,
};

const stateAfterSettlement: Model.LearningState = {
  ...stateWithTask,
  learners: [{ ...assessedLearner, currentVocabulary: updatedVocabulary, updatedAt: at.judged }],
  learnerKnowledgePoints: [settledLearning],
  tasks: [{ ...issuedTask, status: 'completed', completedAt: at.judged }],
  attempts: [settledAttempt],
};

describe('核心流程接口契约模拟', () => {
  /**
   * 测试 1：完整主流程，位于当前 test 块。
   * 路径：创建学习者 → 词表分层抽样 → 生成自评任务 → 创建测评 → 材料分析 →
   * 目标选词 → 初始化 → 排期 → 生成日常任务 → 校验与下发 → received → judging → 评判 → settled → 次日复习。
   * 确认：接口输入输出可衔接，模拟公开视图不含答案，各阶段预置状态通过真实约束校验。
   * 不确认：抽样、题目生成、定级、分析、排期、评判、结算等业务算法；这些函数均为桩。
   */
  test('定级到结算再到下次复习可以串联，且中间状态满足现有约束', () => {
    // 为主流程中的每个领域函数创建类型安全桩；此处不执行任何真实业务算法。
    const createLearner = jest.fn() as jest.MockedFunction<typeof Domain.createLearner>;
    const sampleVocabulary = jest.fn() as jest.MockedFunction<typeof Domain.sampleVocabularyForAssessment>;
    const generateAssessmentTasks = jest.fn() as jest.MockedFunction<typeof Domain.generateVocabularyAssessmentTasks>;
    const createAssessment = jest.fn() as jest.MockedFunction<typeof Domain.createVocabularyAssessment>;
    const toAssessmentView = jest.fn() as jest.MockedFunction<typeof Domain.toLearnerVocabularyAssessmentTask>;
    const recordAssessment = jest.fn() as jest.MockedFunction<typeof Domain.recordVocabularyAssessmentAttempt>;
    const completeAssessment = jest.fn() as jest.MockedFunction<typeof Domain.completeVocabularyAssessment>;
    const createMaterial = jest.fn() as jest.MockedFunction<typeof Domain.createMaterial>;
    const analyzeMaterial = jest.fn() as jest.MockedFunction<typeof Domain.analyzeMaterial>;
    const createGoal = jest.fn() as jest.MockedFunction<typeof Domain.createLearningGoal>;
    const addMaterial = jest.fn() as jest.MockedFunction<typeof Domain.addAnalyzedMaterialToGoal>;
    const selectKnowledgePoint = jest.fn() as jest.MockedFunction<typeof Domain.setGoalKnowledgePointSelection>;
    const derive = jest.fn() as jest.MockedFunction<typeof Domain.deriveInitialFluency>;
    const initialize = jest.fn() as jest.MockedFunction<typeof Domain.initializeLearnerKnowledgePoint>;
    const plan = jest.fn() as jest.MockedFunction<typeof Domain.planDailyStudy>;
    const generateTask = jest.fn() as jest.MockedFunction<typeof Domain.generateLearningTask>;
    const validateGenerated = jest.fn() as jest.MockedFunction<typeof Domain.validateGeneratedTask>;
    const createTask = jest.fn() as jest.MockedFunction<typeof Domain.createLearningTask>;
    const applyDecision = jest.fn() as jest.MockedFunction<typeof Domain.applyDailyStudyDecision>;
    const toTaskView = jest.fn() as jest.MockedFunction<typeof Domain.toLearningTaskView>;
    const recordAttempt = jest.fn() as jest.MockedFunction<typeof Domain.recordTaskAttempt>;
    const startJudging = jest.fn() as jest.MockedFunction<typeof Domain.startTaskAttemptJudging>;
    const judge = jest.fn() as jest.MockedFunction<typeof Domain.judgeTask>;
    const settle = jest.fn() as jest.MockedFunction<typeof Domain.settleTaskAttempt>;

    // 每个桩只返回固定的领域对象；返回值正确性由上方 fixtures 约定，而非由算法计算。
    createLearner.mockReturnValue(initialLearner);
    sampleVocabulary.mockReturnValue([assessmentSample]);
    generateAssessmentTasks.mockReturnValue([assessmentTask]);
    createAssessment.mockReturnValue(inProgressAssessment);
    toAssessmentView.mockReturnValue(publicAssessmentTask);
    recordAssessment.mockReturnValue(assessmentAttempt);
    completeAssessment.mockReturnValue({ assessment: completedAssessment, learner: assessedLearner });
    createMaterial.mockReturnValue(material);
    analyzeMaterial.mockReturnValue(analysis);
    createGoal.mockReturnValue(goal);
    addMaterial.mockReturnValue({
      goal,
      materialLink,
      knowledgePoints: [knowledgePoint],
      candidates: [undecidedCandidate],
      sources: [source],
    });
    selectKnowledgePoint.mockReturnValue(includedCandidate);
    derive.mockReturnValue({
      initialFluency: learning.initialFluency,
      initialization: learning.initialization,
    });
    initialize.mockReturnValue(learning);
    // 第一次排期返回今日新任务，第二次返回次日复习任务，用于模拟学习闭环。
    plan.mockReturnValueOnce(decision).mockReturnValueOnce({
      ...decision,
      date: '2026-11-13',
    });
    // 日常任务生成器也只返回预置题目；后续环节必须消费这个返回值。
    generateTask.mockReturnValue(generated);
    validateGenerated.mockReturnValue(true);
    createTask.mockReturnValue(issuedTask);
    applyDecision.mockReturnValue(stateWithTask);
    toTaskView.mockReturnValue(taskView);
    recordAttempt.mockReturnValue({ state: stateAfterReceipt, attempt: receivedAttempt });
    startJudging.mockReturnValue({ state: stateWhileJudging, attempt: judgingAttempt });
    judge.mockReturnValue(judgement);
    settle.mockReturnValue({ state: stateAfterSettlement, attempt: settledAttempt });

    // 1. 创建学习者，并把 learner.id 传给后续测评。
    const learner = createLearner({
      id: initialLearner.id,
      timezone: initialLearner.timezone,
      dailyTaskCapacity: initialLearner.dailyTaskCapacity,
      now: at.created,
    });
    // 2. 使用仓库词表夹具和每个词段的抽样数量，得到定级样本。
    const samples = sampleVocabulary({
      list,
      families: wordFamilies,
      sampleCounts: { '2k': 1 },
      seed: 'assessment-fixture-seed',
    });
    // 3. 为样本分配任务 ID，并生成服务端自评任务；这里只模拟生成器的返回契约。
    const generatedAssessmentTasks = generateAssessmentTasks({
      samples,
      taskIds: [assessmentTask.id],
    });
    // 4. 创建测评时消费生成器输出，不再直接使用原始 assessmentTask fixture。
    const assessment = createAssessment({
      id: inProgressAssessment.id,
      learnerId: learner.id,
      tasks: generatedAssessmentTasks,
      now: at.created,
    });
    // 5. 生成自评任务并转换为公开视图，自评和完成测评都使用同一项任务。
    const learnerAssessmentTask = toAssessmentView(generatedAssessmentTasks[0]);
    const vocabularyAttempt = recordAssessment({
      attemptId: assessmentAttempt.id,
      assessment,
      task: generatedAssessmentTasks[0],
      previousAttempts: [],
      known: true,
      answeredAt: at.assessed,
    });
    // 6. 自评结果进入测评完成接口，产出词汇估计和更新后的学习者。
    const assessmentResult = completeAssessment({
      learner,
      assessment,
      tasks: generatedAssessmentTasks,
      attempts: [vocabularyAttempt],
      list,
      bandWordFamilyCounts: { '2k': 2000 },
      now: at.assessed,
    });
    // 7. 创建材料并把完整 material 传给分析接口，检查材料导入与分析能够衔接。
    const importedMaterial = createMaterial({
      id: material.id,
      learnerId: learner.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
      mimeType: material.mimeType,
      checksum: material.checksum,
      storageKey: material.storageKey,
      extractedText: material.extractedText,
      extractionMetadata: material.extractionMetadata,
      now: at.analyzed,
    });
    const materialAnalysis = analyzeMaterial({
      analysisId: analysis.id,
      material: importedMaterial,
      analyzerVersion: analysis.analyzerVersion,
      now: at.analyzed,
      assignments: [{
        lemma: 'run',
        senseId: 'placeholder:1',
        partOfSpeech: null,
        definition: 'Meaning of run in the source material',
        occurrences: [{ rawForm: 'run', sentence: 'I run every morning.', context: [] }],
      }],
    });
    // 8. 将目标、材料和已完成分析组合为目标学习范围。
    const learningGoal = createGoal({
      id: goal.id,
      learnerId: learner.id,
      title: goal.title,
      targetFluency: goal.targetFluency,
      now: at.analyzed,
    });
    const scope = addMaterial({
      goal: learningGoal,
      material: importedMaterial,
      analysis: materialAnalysis,
      existingCandidates: [],
      existingSources: [],
      addedAt: at.analyzed,
    });
    // 9. 从范围结果中选择候选知识点，再把该知识点用于初始化。
    const selected = selectKnowledgePoint(scope.candidates[0], {
      selection: 'included',
      now: at.analyzed,
    });
    const currentVocabulary = assessmentResult.learner.currentVocabulary;
    expect(currentVocabulary).toBe(vocabulary);
    // 10. 词汇估计先推导初始流利度，再把 derived 原样传给初始化接口。
    const derived = derive({
      vocabulary: currentVocabulary!,
      classification,
      policyVersion: 'initial-v1',
    });
    const initialized = initialize({
      learnerId: learner.id,
      knowledgePoint: scope.knowledgePoints[0],
      derived,
      now: at.analyzed,
    });

    // 抽样结果必须来自词表中的 run 词族，并保留该词族的 2k 分层。
    expect(samples).toEqual([expect.objectContaining({ familyId: 'fixture-2', band: '2k' })]);
    // 生成器必须消费抽样结果，创建测评必须消费生成器输出。
    expect(generateAssessmentTasks).toHaveBeenCalledWith({ samples, taskIds: [assessmentTask.id] });
    expect(createAssessment).toHaveBeenCalledWith(expect.objectContaining({ tasks: generatedAssessmentTasks }));
    // 公开自评任务只呈现词汇，不包含选项、正确答案或服务端完整知识点。
    expect(learnerAssessmentTask).not.toHaveProperty('options');
    expect(learnerAssessmentTask).not.toHaveProperty('answerOptionId');
    expect(learnerAssessmentTask).not.toHaveProperty('knowledgePoint');
    expect(selected).toBe(includedCandidate);
    // 初始化结果必须保留推导阶段的证据对象。
    expect(initialized.initialization).toBe(derived.initialization);
    // 这是真实约束校验：排期前的完整学习状态不应有任何约束错误。
    expect(validateLearningState(stateBeforePlanning)).toEqual([]);

    // 11. 从完整学习状态生成今日决策，并取出需要生成的新任务规格。
    const dailyDecision = plan(stateBeforePlanning, {
      learnerId: learner.id,
      date: '2026-11-12',
      now: at.planned,
    });
    const plannedTask = dailyDecision.tasks[0];
    expect(plannedTask.source).toBe('new');
    if (plannedTask.source !== 'new') throw new Error('测试需要新任务位置');

    // 12. 排期规格、知识点和来源材料进入生成器，得到服务端完整题目。
    const generatedTask = generateTask({
      specification: plannedTask.specification,
      knowledgePoint,
      sourceMaterials: [importedMaterial],
    });
    // 13. 生成器输出先与排期规格校验，再把同一生成结果组装为学习任务。
    expect(validateGenerated(plannedTask.specification, generatedTask)).toBe(true);
    const task = createTask({
      id: issuedTask.id,
      learnerId: learner.id,
      specification: plannedTask.specification,
      generated: generatedTask,
      issuedAt: at.planned,
    });
    // 14. 将决策和已生成任务应用到状态；新建计划时需要 planId。
    const plannedState = applyDecision(stateBeforePlanning, {
      planId: studyPlan.id,
      decision: dailyDecision,
      newTasks: [task],
      now: at.planned,
    });
    const publicTask = toTaskView(task);
    // 15. 原始提交只在 recordTaskAttempt 出现一次，产生 received 作答。
    const received = recordAttempt(plannedState, {
      attemptId: receivedAttempt.id,
      taskId: task.id,
      submission,
      validity: receivedAttempt.validity,
      receivedAt: at.judged,
    });
    // 16. 使用上一环节返回的 state 和 attempt.id 进入 judging。
    const judging = startJudging(received.state, { attemptId: received.attempt.id });
    const taskJudgement = judge({
      task,
      submission: received.attempt.submission,
      judgedAt: at.judged,
    });
    // 17. 结算只传 attemptId、评判和结算时间，不再重复原始提交。
    const settlement = settle(judging.state, {
      attemptId: judging.attempt.id,
      judgement: taskJudgement,
      now: at.judged,
    });
    // 18. 把结算后的状态重新交给排期器，模拟到期后进入次日复习。
    const nextDecision = plan(settlement.state, {
      learnerId: learner.id,
      date: '2026-11-13',
      now: at.nextDay,
    });

    // 确认日常任务生成器收到排期规格、目标知识点和导入材料。
    expect(generateTask).toHaveBeenCalledWith({
      specification: plannedTask.specification,
      knowledgePoint,
      sourceMaterials: [importedMaterial],
    });
    // 应用排期时，必须同时收到原状态、对应决策和已生成任务。
    expect(applyDecision).toHaveBeenCalledWith(stateBeforePlanning, expect.objectContaining({
      decision: dailyDecision,
      newTasks: [task],
    }));
    // 公开学习任务视图不能泄露选择题答案或解释。
    expect(publicTask.content.content).not.toHaveProperty('answerOptionId');
    expect(publicTask.content.content).not.toHaveProperty('explanation');
    // 评判结果必须绑定当前任务，供异步评判和结算核对。
    expect(taskJudgement.taskId).toBe(task.id);
    // 以下四次调用真实执行约束校验，分别覆盖下发、接收、评判中和结算后状态。
    expect(validateLearningState(plannedState)).toEqual([]);
    expect(validateLearningState(received.state)).toEqual([]);
    expect(validateLearningState(judging.state)).toEqual([]);
    expect(validateLearningState(settlement.state)).toEqual([]);
    // 返回的 settled 作答必须进入返回状态，且复习到期时间进入下一天。
    expect(settlement.state.attempts).toContain(settlement.attempt);
    expect(settlement.state.learnerKnowledgePoints[0].dimensions.R.review.dueAt).toBe(at.nextDay);
    // 第二次排期必须消费结算后的状态，而不是旧的排期前状态。
    expect(plan).toHaveBeenNthCalledWith(2, settlement.state, {
      learnerId: learner.id,
      date: '2026-11-13',
      now: at.nextDay,
    });
    expect(nextDecision.tasks).toEqual([{ source: 'new', specification }]);
  });

});
