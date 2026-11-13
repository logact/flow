/// <reference types="jest" />

import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import type { SemanticJudgementResult, TaskAIJudge } from '../lib/application/ai-judge';
import { judgeAndSettleTaskAttempt } from '../lib/application/judge-settle-task-attempt';
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
  judged: '2026-11-12T00:45:00.000Z',
  settled: '2026-11-12T00:50:00.000Z',
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

// 与领域函数测试相同的路径：真实走一遍定级与初始化，使作答可以真实结算。
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
    seed: 's11-test',
  });
  const assessmentTasks = Domain.generateVocabularyAssessmentTasks({ samples, taskIds: ['assessment-task-1'] });
  const assessment = Domain.createVocabularyAssessment({
    id: 'assessment-1',
    learnerId: learner.id,
    tasks: assessmentTasks,
    now: at.created,
  });
  // 故意报告不认识，使初始流利度为 0，便于断言结算后的绝对分数。
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
  // 词义归属由应用层消歧生成；测试中用提取到的词项加占位义项构造。
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

function receive(
  state: Model.LearningState,
  task: Model.LearningTask,
  submission: Model.TaskSubmission,
  attemptId: string,
  elapsedMs = 5000,
): Domain.RecordTaskAttemptResult {
  return Domain.recordTaskAttempt(state, {
    attemptId,
    taskId: task.id,
    submission,
    validity: { elapsedMs, interrupted: false },
    receivedAt: at.received,
  });
}

function aiJudgeReturning(result: SemanticJudgementResult): {
  judge: jest.MockedFunction<TaskAIJudge['judge']>;
} {
  const judge = jest.fn() as jest.MockedFunction<TaskAIJudge['judge']>;
  judge.mockResolvedValue(result);
  return { judge };
}

function aiJudgeThrowing(message: string): {
  judge: jest.MockedFunction<TaskAIJudge['judge']>;
} {
  const judge = jest.fn() as jest.MockedFunction<TaskAIJudge['judge']>;
  judge.mockRejectedValue(new Error(message));
  return { judge };
}

function settle(
  repository: InMemoryLearningStateRepository,
  aiJudge: TaskAIJudge,
  attemptId: string,
  logger: AppLogger = silentLogger,
) {
  return judgeAndSettleTaskAttempt(
    repository,
    aiJudge,
    { attemptId, judgedAt: at.judged, now: at.settled },
    logger,
  );
}

/** 捕获日志消息与结构化字段的测试 logger。 */
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

describe('S11 评判并结算学习任务作答', () => {
  test('选择题走规则评判：不调用 AI，按 RETRIEVE 赋分表结算', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'RETRIEVE', axis: 'R', stage: 'choice',
    }, 'task-choice');
    const received = receive(state, task, { task: 'RETRIEVE', stage: 'choice', selectedOptionId: 'a' }, 'attempt-1');
    const repo = new InMemoryLearningStateRepository(received.state);
    const aiJudge = aiJudgeReturning({ taskId: task.id, feedback: '不应被调用' });

    const result = await settle(repo, aiJudge, 'attempt-1');

    expect(aiJudge.judge).not.toHaveBeenCalled();
    expect(result.feedback).toBe('Correct');
    const saved = repo.load().state;
    const attempt = saved.attempts[0];
    expect(attempt.status).toBe('settled');
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.judgedBy).toBe('rule');
    expect(attempt.judgement.dimensions.R).toMatchObject({ outcome: 'correct', score: 1 });
    expect(attempt.settlement).toEqual(result.settlement);
    expect(saved.tasks[0].status).toBe('completed');
    // RETRIEVE choice 通过按绝对赋分表设为 20；词汇估计随结算更新。
    expect(saved.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(20);
    expect(result.settlement.vocabularyAfter.estimatedAt).toBe(at.settled);
    expect(result.settlement.vocabularyAfter.bands[0]).toMatchObject({ sampleCount: 2, knownCount: 1 });
    expect(validateLearningState(saved)).toEqual([]);
  });

  test('ENCODE 走规则评判并同时结算 R/P 两个维度', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'ENCODE',
    }, 'task-encode');
    const received = receive(state, task, { task: 'ENCODE' }, 'attempt-encode');
    const repo = new InMemoryLearningStateRepository(received.state);
    const aiJudge = aiJudgeReturning({ taskId: task.id, feedback: '不应被调用' });

    await settle(repo, aiJudge, 'attempt-encode');

    expect(aiJudge.judge).not.toHaveBeenCalled();
    const saved = repo.load().state;
    const attempt = saved.attempts[0];
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.dimensions).toEqual({
      R: { outcome: 'correct', score: 1 },
      P: { outcome: 'correct', score: 1 },
    });
    expect(saved.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(5);
    expect(saved.learnerKnowledgePoints[0].dimensions.P.fluency).toBe(5);
    expect(validateLearningState(saved)).toEqual([]);
  });

  test('RETRIEVE cued 由 AI 评判并进入同一结算路径', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'RETRIEVE', axis: 'R', stage: 'cued',
    }, 'task-cued');
    const submission: Model.TextRetrieveTaskSubmission = {
      task: 'RETRIEVE',
      stage: 'cued',
      answer: 'It means to move quickly.',
    };
    const received = receive(state, task, submission, 'attempt-cued');
    const repo = new InMemoryLearningStateRepository(received.state);
    const aiJudge = aiJudgeReturning({
      taskId: task.id,
      retrieveAccepted: true,
      feedback: '释义正确',
    });

    const result = await settle(repo, aiJudge, 'attempt-cued');

    expect(aiJudge.judge).toHaveBeenCalledTimes(1);
    const judged = aiJudge.judge.mock.calls[0][0];
    expect(judged.task.id).toBe(task.id);
    expect(judged.submission).toEqual(submission);
    expect(result.feedback).toBe('释义正确');
    const attempt = repo.load().state.attempts[0];
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.judgedBy).toBe('ai');
    expect(attempt.judgement.dimensions.R).toEqual({ outcome: 'correct', score: 1 });
    expect(repo.load().state.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(40);
    expect(validateLearningState(repo.load().state)).toEqual([]);
  });

  test('阅读任务合并规则与 AI 结果：自由题通过时给出完整 FLUENCY 证据', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'FLUENCY', axis: 'R',
    }, 'task-reading');
    if (task.content.task !== 'FLUENCY' || task.content.content.axis !== 'R') {
      throw new Error('expected reading task');
    }
    const questions = task.content.content.questions;
    const freeQuestion = questions.find((question) => question.kind === 'free');
    if (!freeQuestion || freeQuestion.kind !== 'free') throw new Error('expected a free question');
    const submission: Model.ReadingFluencyTaskSubmission = {
      task: 'FLUENCY',
      axis: 'R',
      readingElapsedMs: 60000,
      answers: questions.map((question) => question.kind === 'choice'
        ? { questionId: question.id, kind: 'choice', selectedOptionId: question.answerOptionId }
        : { questionId: question.id, kind: 'free', answer: 'The passage is about running every morning.' }),
    };
    const received = receive(state, task, submission, 'attempt-reading');
    const repo = new InMemoryLearningStateRepository(received.state);
    const aiJudge = aiJudgeReturning({
      taskId: task.id,
      readingFreeQuestions: [{ questionId: freeQuestion.id, correct: true }],
      feedback: '理解正确',
    });

    await settle(repo, aiJudge, 'attempt-reading');

    // AI 只对自由题给出正误；选择题由规则合并进同一 R 维度评判。
    expect(aiJudge.judge).toHaveBeenCalledTimes(1);
    const attempt = repo.load().state.attempts[0];
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.judgedBy).toBe('ai');
    expect(attempt.judgement.dimensions.R).toMatchObject({
      outcome: 'correct',
      score: 1,
      targetPassed: true,
      overallPassed: true,
      // passage 为 'I run every morning.'，4 词 / 1 分钟。
      speedWpm: 4,
    });
    // 速度与双通过不满足 R 阈值，按规则落到 40。
    expect(repo.load().state.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(40);
    expect(validateLearningState(repo.load().state)).toEqual([]);
  });

  test('阅读任务自由题未通过时整体不通过，流利度保持原分', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'FLUENCY', axis: 'R',
    }, 'task-reading-partial');
    if (task.content.task !== 'FLUENCY' || task.content.content.axis !== 'R') {
      throw new Error('expected reading task');
    }
    const questions = task.content.content.questions;
    const freeQuestion = questions.find((question) => question.kind === 'free');
    if (!freeQuestion || freeQuestion.kind !== 'free') throw new Error('expected a free question');
    const submission: Model.ReadingFluencyTaskSubmission = {
      task: 'FLUENCY',
      axis: 'R',
      readingElapsedMs: 60000,
      answers: questions.map((question) => question.kind === 'choice'
        ? { questionId: question.id, kind: 'choice', selectedOptionId: question.answerOptionId }
        : { questionId: question.id, kind: 'free', answer: 'Something unrelated.' }),
    };
    const received = receive(state, task, submission, 'attempt-reading-partial');
    const repo = new InMemoryLearningStateRepository(received.state);
    const aiJudge = aiJudgeReturning({
      taskId: task.id,
      readingFreeQuestions: [{ questionId: freeQuestion.id, correct: false }],
      feedback: '概括偏离原文',
    });

    await settle(repo, aiJudge, 'attempt-reading-partial');

    const attempt = repo.load().state.attempts[0];
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.dimensions.R).toMatchObject({
      outcome: 'partial',
      score: 0.5,
      targetPassed: true,
      overallPassed: false,
    });
    expect(repo.load().state.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(0);
    expect(validateLearningState(repo.load().state)).toEqual([]);
  });

  test('P 场景表达由 AI 评判，速度按产出词数与作答总耗时计算', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'FLUENCY', axis: 'P',
    }, 'task-production');
    const submission: Model.ProductionFluencyTaskSubmission = {
      task: 'FLUENCY',
      axis: 'P',
      response: 'I run every morning.',
    };
    const received = receive(state, task, submission, 'attempt-production', 5000);
    const repo = new InMemoryLearningStateRepository(received.state);
    const aiJudge = aiJudgeReturning({
      taskId: task.id,
      production: { targetPassed: true, overallPassed: true },
      feedback: '目标表达使用自然',
    });

    await settle(repo, aiJudge, 'attempt-production');

    const attempt = repo.load().state.attempts[0];
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.judgedBy).toBe('ai');
    // 4 词 / 5000ms → 48 wpm。
    expect(attempt.judgement.dimensions.P).toMatchObject({
      outcome: 'correct',
      score: 1,
      targetPassed: true,
      overallPassed: true,
      speedWpm: 48,
    });
    const fluency = repo.load().state.learnerKnowledgePoints[0].dimensions.P.fluency;
    expect(fluency).toBeCloseTo(60 + (48 - 25) * 40 / 35, 5);
    expect(validateLearningState(repo.load().state)).toEqual([]);
  });

  test('重复结算同一作答返回已有结果，不产生新写入', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'RETRIEVE', axis: 'R', stage: 'cued',
    }, 'task-idempotent');
    const received = receive(state, task, { task: 'RETRIEVE', stage: 'cued', answer: 'to move quickly' }, 'attempt-idempotent');
    const repo = new InMemoryLearningStateRepository(received.state);
    const first = await settle(
      repo, aiJudgeReturning({ taskId: task.id, retrieveAccepted: true, feedback: 'ok' }), 'attempt-idempotent');
    const revisionAfterFirst = repo.load().revision;

    const second = await settle(repo, aiJudgeThrowing('不应再次评判'), 'attempt-idempotent');

    expect(second.feedback).toBe(first.feedback);
    expect(second.settlement).toEqual(first.settlement);
    expect(repo.load().revision).toBe(revisionAfterFirst);
  });

  test('AI 失败时不结算并保留原始作答，重试后从 judging 续评判', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'RETRIEVE', axis: 'R', stage: 'free',
    }, 'task-retry');
    const submission: Model.TextRetrieveTaskSubmission = { task: 'RETRIEVE', stage: 'free', answer: 'to move quickly' };
    const received = receive(state, task, submission, 'attempt-retry');
    const repo = new InMemoryLearningStateRepository(received.state);

    await expect(settle(repo, aiJudgeThrowing('AI 不可用'), 'attempt-retry')).rejects.toThrow('AI 不可用');

    // 失败不调用结算：作答保持 judging，原始提交不被替换。
    const failed = repo.load().state;
    const judgingAttempt = failed.attempts[0];
    expect(judgingAttempt.status).toBe('judging');
    expect(judgingAttempt.submission).toEqual(submission);
    expect(failed.tasks[0].status).toBe('issued');
    expect(validateLearningState(failed)).toEqual([]);

    const settled = await settle(
      repo, aiJudgeReturning({ taskId: task.id, retrieveAccepted: true, feedback: 'ok' }), 'attempt-retry');
    const saved = repo.load().state;
    const attempt = saved.attempts[0];
    if (attempt.status !== 'settled') throw new Error('expected settled attempt');
    expect(attempt.judgement.judgedBy).toBe('ai');
    expect(attempt.submission).toEqual(submission);
    expect(saved.learnerKnowledgePoints[0].dimensions.R.fluency).toBe(60);
    expect(settled.settlement.settledAt).toBe(at.settled);
    expect(validateLearningState(saved)).toEqual([]);
  });

  test('关键步骤写入结构化日志', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'RETRIEVE', axis: 'R', stage: 'cued',
    }, 'task-log');
    const received = receive(
      state, task, { task: 'RETRIEVE', stage: 'cued', answer: 'to move quickly' }, 'attempt-log');
    const repo = new InMemoryLearningStateRepository(received.state);
    const capture = captureLogger();

    await expect(settle(repo, aiJudgeThrowing('AI 不可用'), 'attempt-log', capture.logger))
      .rejects.toThrow('AI 不可用');
    await settle(
      repo, aiJudgeReturning({ taskId: task.id, retrieveAccepted: true, feedback: 'ok' }), 'attempt-log', capture.logger);

    const messages = capture.entries.map((entry) => entry.msg);
    expect(messages).toContain('作答已转入评判中');
    expect(messages).toContain('AI 评判失败或结果未通过校验，保留原始作答待重试');
    expect(messages).toContain('AI 评判完成');
    expect(messages).toContain('作答结算完成');
    // 所有日志都绑定 attemptId，便于串联一次作答的处理轨迹。
    expect(capture.entries.every((entry) => entry.obj.attemptId === 'attempt-log')).toBe(true);
  });

  test('AI 结果未通过校验时不调用结算', async () => {
    const base = buildInitializedState();
    const wordId = base.knowledgePoints[0].id;
    const { state: s1, task: cuedTask } = makeTask(base, {
      goalId: 'goal-1', wordId, task: 'RETRIEVE', axis: 'R', stage: 'cued',
    }, 'task-bad-id');
    const { state: s2, task: readingTask } = makeTask(s1, {
      goalId: 'goal-1', wordId, task: 'FLUENCY', axis: 'R',
    }, 'task-missing-verdict');
    if (readingTask.content.task !== 'FLUENCY' || readingTask.content.content.axis !== 'R') {
      throw new Error('expected reading task');
    }
    const readingSubmission: Model.ReadingFluencyTaskSubmission = {
      task: 'FLUENCY',
      axis: 'R',
      readingElapsedMs: 60000,
      answers: readingTask.content.content.questions.map((question) => question.kind === 'choice'
        ? { questionId: question.id, kind: 'choice', selectedOptionId: question.answerOptionId }
        : { questionId: question.id, kind: 'free', answer: 'A summary.' }),
    };
    const r1 = receive(s2, cuedTask, { task: 'RETRIEVE', stage: 'cued', answer: 'to move quickly' }, 'attempt-bad-id');
    const r2 = receive(r1.state, readingTask, readingSubmission, 'attempt-missing-verdict');
    const repo = new InMemoryLearningStateRepository(r2.state);

    // taskId 与任务不匹配。
    await expect(settle(
      repo,
      aiJudgeReturning({ taskId: 'another-task', retrieveAccepted: true, feedback: null }),
      'attempt-bad-id',
    )).rejects.toThrow('belongs to another task');
    // 阅读自由题缺少语义正误覆盖。
    await expect(settle(
      repo,
      aiJudgeReturning({ taskId: readingTask.id, readingFreeQuestions: [], feedback: null }),
      'attempt-missing-verdict',
    )).rejects.toThrow('cover every free reading question');

    const saved = repo.load().state;
    expect(saved.attempts.map((attempt) => attempt.status)).toEqual(['judging', 'judging']);
    expect(saved.tasks.every((task) => task.status === 'issued')).toBe(true);
    expect(validateLearningState(saved)).toEqual([]);
  });

  test('invalid 作答不进入评判，也不产生写入', async () => {
    const base = buildInitializedState();
    const { state, task } = makeTask(base, {
      goalId: 'goal-1', wordId: base.knowledgePoints[0].id, task: 'RETRIEVE', axis: 'R', stage: 'choice',
    }, 'task-invalid');
    const received = Domain.recordTaskAttempt(state, {
      attemptId: 'attempt-invalid',
      taskId: task.id,
      submission: { task: 'RETRIEVE', stage: 'choice', selectedOptionId: 'a' },
      validity: { elapsedMs: 1000, interrupted: true },
      receivedAt: at.received,
    });
    expect(received.attempt.status).toBe('invalid');
    const repo = new InMemoryLearningStateRepository(received.state);
    const revision = repo.load().revision;

    await expect(settle(repo, aiJudgeThrowing('不应被调用'), 'attempt-invalid'))
      .rejects.toThrow('cannot be judged');

    expect(repo.load().revision).toBe(revision);
    expect(repo.load().state.attempts[0].status).toBe('invalid');
  });

  test('保存时检测并发冲突：其他作答先结算则不覆盖其结果', async () => {
    const base = buildInitializedState();
    const wordId = base.knowledgePoints[0].id;
    const { state: s1, task: taskA } = makeTask(base, {
      goalId: 'goal-1', wordId, task: 'RETRIEVE', axis: 'R', stage: 'cued',
    }, 'task-a');
    const { state: s2, task: taskB } = makeTask(s1, {
      goalId: 'goal-1', wordId, task: 'RETRIEVE', axis: 'R', stage: 'choice',
    }, 'task-b');
    const choiceSubmission: Model.ChoiceRetrieveTaskSubmission = {
      task: 'RETRIEVE',
      stage: 'choice',
      selectedOptionId: 'a',
    };
    const r1 = receive(s2, taskA, { task: 'RETRIEVE', stage: 'cued', answer: 'to move quickly' }, 'attempt-a');
    const r2 = receive(r1.state, taskB, choiceSubmission, 'attempt-b');
    const repo = new InMemoryLearningStateRepository(r2.state);
    const aiJudge: TaskAIJudge = {
      judge: jest.fn(async () => {
        // 模拟并发：attempt-a 评判期间，attempt-b 先完成结算并保存。
        const current = repo.load();
        const judging = Domain.startTaskAttemptJudging(current.state, { attemptId: 'attempt-b' });
        const judgement = Domain.judgeTask({ task: taskB, submission: choiceSubmission, judgedAt: at.judged });
        const settled = Domain.settleTaskAttempt(judging.state, {
          attemptId: 'attempt-b',
          judgement,
          now: at.settled,
        });
        repo.save(settled.state, current.revision);
        return { taskId: taskA.id, retrieveAccepted: true, feedback: 'ok' };
      }),
    };

    await expect(settle(repo, aiJudge, 'attempt-a')).rejects.toBeInstanceOf(ConcurrencyConflictError);

    const saved = repo.load().state;
    const attemptA = saved.attempts.find((attempt) => attempt.id === 'attempt-a');
    const attemptB = saved.attempts.find((attempt) => attempt.id === 'attempt-b');
    expect(attemptA?.status).toBe('judging');
    expect(attemptB?.status).toBe('settled');
    expect(saved.tasks.find((task) => task.id === 'task-b')?.status).toBe('completed');
    expect(validateLearningState(saved)).toEqual([]);
  });
});
