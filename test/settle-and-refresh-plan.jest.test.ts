/// <reference types="jest" />

import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import type { SemanticJudgementResult, TaskAIJudge } from '../lib/application/ai-judge';
import { InMemoryLearningStateRepository } from '../lib/application/repository';
import { settleAndRefreshPlan } from '../lib/application/settle-and-refresh-plan';
import type { SettleAndRefreshPlanResult } from '../lib/application/settle-and-refresh-plan';
import * as Domain from '../lib/domain/functions';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';
import { FakeTaskAIProvider, InMemoryTaskRepository } from './helpers/task-generation-fixture';
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
  judged: '2026-11-12T00:45:00.000Z',
  settled: '2026-11-12T00:50:00.000Z',
  // 结算后复习间隔为 1 天，刷新时间推进到到期之后，重排才会产生下一任务。
  refreshed: '2026-11-13T02:00:00.000Z',
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

// 与 S11 测试同源的路径：真实走一遍定级与初始化，使作答可以真实结算。
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
    seed: 'r2-test',
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

function setupWithChoiceAttempt(): {
  repository: InMemoryLearningStateRepository;
  taskRepository: InMemoryTaskRepository;
  aiJudge: jest.MockedFunction<TaskAIJudge['judge']>;
} {
  const base = buildInitializedState();
  const specification: Domain.TaskSpecification = {
    goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'RETRIEVE', axis: 'R', stage: 'choice',
  };
  const generated = Domain.generateLearningTask({
    specification,
    knowledgePoint: base.knowledgePoints[0],
    sourceMaterials: base.materials,
  });
  const task = Domain.createLearningTask({
    id: 'task-choice',
    learnerId: base.learners[0].id,
    specification,
    generated,
    issuedAt: at.planned,
  });
  const content = task.content;
  if (content.task !== 'RETRIEVE' || content.content.stage !== 'choice') {
    throw new Error('expected a choice retrieve task');
  }
  const choice = content.content;
  // 故意选错选项，使结算后复习间隔为 0、dueAt 等于 now，同一 now 重排即产生下一任务。
  const wrongOption = choice.options.find((option) => option.id !== choice.answerOptionId)!;
  const stateWithTask = { ...base, tasks: [...base.tasks, task] };
  const received = Domain.recordTaskAttempt(stateWithTask, {
    attemptId: 'attempt-choice',
    taskId: task.id,
    submission: { task: 'RETRIEVE', stage: 'choice', selectedOptionId: wrongOption.id },
    validity: { elapsedMs: 5000, interrupted: false },
    receivedAt: at.received,
  });
  const state = received.state;
  const repository = new InMemoryLearningStateRepository(state);
  const aiJudge = jest.fn() as jest.MockedFunction<TaskAIJudge['judge']>;
  aiJudge.mockResolvedValue({ taskId: task.id, feedback: '不应被调用' } satisfies SemanticJudgementResult);
  return { repository, taskRepository: new InMemoryTaskRepository(state), aiJudge };
}

/** 用 Domain 本地生成器作为 Fake AI Provider 的输出，任意规格都能返回合法题目。 */
function providerFromDomain(): FakeTaskAIProvider {
  return new FakeTaskAIProvider((request) => JSON.stringify(Domain.generateLearningTask({
    specification: request.specification,
    knowledgePoint: request.knowledgePoint,
    sourceMaterials: request.sourceMaterials,
  })));
}

function settle(
  repository: InMemoryLearningStateRepository,
  taskRepository: InMemoryTaskRepository,
  aiJudge: jest.MockedFunction<TaskAIJudge['judge']>,
  aiProvider: FakeTaskAIProvider,
): Promise<SettleAndRefreshPlanResult> {
  return settleAndRefreshPlan(
    {
      repository,
      aiJudge: { judge: aiJudge },
      taskRepository,
      aiProvider,
      newTaskId: () => 'task-review-1',
      logger: silentLogger,
    },
    { attemptId: 'attempt-choice', judgedAt: at.judged, now: at.refreshed },
  );
}

describe('R2：结算并刷新计划（settleAndRefreshPlan）', () => {
  test('S11 结算成功后同一请求内刷新当日计划', async () => {
    const { repository, taskRepository, aiJudge } = setupWithChoiceAttempt();
    const provider = providerFromDomain();

    const result = await settle(repository, taskRepository, aiJudge, provider);

    // 选择题走规则评判，AI 评判不介入。
    expect(aiJudge).not.toHaveBeenCalled();
    expect(result.settlement).toBeDefined();
    const attempt = repository.load().state.attempts[0];
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.dimensions.R).toEqual({ outcome: 'incorrect', score: 0 });

    // now 按学习者时区（Asia/Shanghai）换算当日日期 2026-11-13，重排产生到期复习任务。
    if (!result.refresh.ok) throw new Error(`expected refresh ok, got ${result.refresh.reason}`);
    expect(result.refresh.plan.date).toBe('2026-11-13');
    expect(result.refresh.plan.taskIds).toEqual(['task-review-1']);
    expect(result.refresh.tasks.map((task) => task.id)).toEqual(['task-review-1']);
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(validateLearningState(repository.load().state)).toEqual([]);
  });

  test('重复调用幂等：已结算作答直接返回，计划不重复生成任务', async () => {
    const { repository, taskRepository, aiJudge } = setupWithChoiceAttempt();
    const provider = providerFromDomain();

    const first = await settle(repository, taskRepository, aiJudge, provider);
    const requestsAfterFirst = provider.requests.length;
    const second = await settle(repository, taskRepository, aiJudge, provider);

    expect(second.settlement).toEqual(first.settlement);
    expect(aiJudge).not.toHaveBeenCalled();
    if (!first.refresh.ok || !second.refresh.ok) throw new Error('expected refresh ok');
    expect(second.refresh.plan.taskIds).toEqual(first.refresh.plan.taskIds);
    expect(provider.requests.length).toBe(requestsAfterFirst);
  });

  test('R1 失败不回滚结算：已结算但当日计划未刷新，是可收敛暂态', async () => {
    const { repository, taskRepository, aiJudge } = setupWithChoiceAttempt();
    const failing = new FakeTaskAIProvider(() => {
      throw new Error('供应商不可用');
    });

    const result = await settle(repository, taskRepository, aiJudge, failing);

    expect(result.settlement).toBeDefined();
    expect(result.refresh).toEqual({ ok: false, reason: 'task_generation_failed' });
    const saved = repository.load().state;
    expect(saved.attempts[0].status).toBe('settled');
    expect(saved.studyPlans).toEqual([]);
    // 结算两次落库（judging、settled）仍生效，之后任何一次 R1 调用都会收敛。
    expect(repository.load().revision).toBe(2);
    expect(validateLearningState(saved)).toEqual([]);
  });

  test('S11 失败整体抛出，不进入 R1、不调用 AI 生成', async () => {
    const { repository, taskRepository, aiJudge } = setupWithChoiceAttempt();
    const provider = providerFromDomain();

    await expect(settleAndRefreshPlan(
      {
        repository,
        aiJudge: { judge: aiJudge },
        taskRepository,
        aiProvider: provider,
        logger: silentLogger,
      },
      { attemptId: 'attempt-missing', judgedAt: at.judged, now: at.refreshed },
    )).rejects.toThrow('Attempt not found');
    expect(provider.requests).toHaveLength(0);
    expect(repository.load().revision).toBe(0);
  });
});
