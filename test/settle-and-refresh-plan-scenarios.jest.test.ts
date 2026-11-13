/// <reference types="jest" />

import type { SemanticJudgementResult, TaskAIJudge } from '../lib/application/ai-judge';
import type { LearningTaskRepository, TaskGenerationAIProvider, TaskGenerationAIRequest } from '../lib/application/ports';
import type { LearningStateRepository } from '../lib/application/repository';
import { refreshDailyPlanUseCase } from '../lib/application/refresh-daily-plan';
import type { RefreshDailyPlanResult } from '../lib/application/refresh-daily-plan';
import { settleAndRefreshPlan } from '../lib/application/settle-and-refresh-plan';
import type { SettleAndRefreshPlanResult } from '../lib/application/settle-and-refresh-plan';
import * as Domain from '../lib/domain/functions';
import type * as Model from '../lib/domain/model';
import {
  at,
  fixtureAiOutputs,
  RecordingStateRepository,
  setup,
} from './helpers/apply-daily-plan-fixture';
import { FakeTaskAIProvider, InMemoryTaskRepository, learnerId } from './helpers/task-generation-fixture';
import { silentLogger } from './helpers/silent-logger';

const day = {
  planned: at.planned,
  answered: '2026-11-13T04:30:00.000Z',
  settled: '2026-11-13T05:00:00.000Z',
  review3Later: '2026-11-16T06:00:00.000Z',
  review30Later: '2026-12-13T06:00:00.000Z',
};

function idSequence(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

/** 场景 provider：优先用夹具固定输出（能通过校验），未覆盖的规格回退 Domain 本地生成器。 */
function matchesSpec(item: Model.GeneratedTask, specification: Domain.TaskSpecification): boolean {
  if (item.task !== specification.task || item.wordId !== specification.wordId) return false;
  if (item.task === 'RETRIEVE') {
    return item.content.stage === (specification.task === 'RETRIEVE' ? specification.stage : null);
  }
  if (item.task === 'FLUENCY') {
    return item.content.axis === (specification.task === 'FLUENCY' ? specification.axis : null);
  }
  return true;
}

function scenarioProvider(): FakeTaskAIProvider {
  return new FakeTaskAIProvider((request: TaskGenerationAIRequest) => {
    const { specification } = request;
    const fixed = fixtureAiOutputs.find((item) => matchesSpec(item, specification));
    if (fixed) return JSON.stringify(fixed);
    return JSON.stringify(Domain.generateLearningTask({
      specification: request.specification,
      knowledgePoint: request.knowledgePoint,
      sourceMaterials: request.sourceMaterials,
    }));
  });
}

/** 每次从状态仓库实时取快照的 S08 读取端口，避免过期状态。 */
function liveTaskRepository(repository: LearningStateRepository): LearningTaskRepository {
  return {
    loadTaskGenerationContext: (goalId, knowledgePointId) =>
      new InMemoryTaskRepository(repository.load().state)
        .loadTaskGenerationContext(goalId, knowledgePointId),
  };
}

interface Harness {
  repository: RecordingStateRepository;
  provider: FakeTaskAIProvider;
  taskIds: () => string;
  planIds: () => string;
  aiJudge: jest.MockedFunction<TaskAIJudge['judge']>;
}

function harness(mutate?: (state: Model.LearningState) => void): Harness {
  const { repository } = setup(mutate);
  const aiJudge = jest.fn() as jest.MockedFunction<TaskAIJudge['judge']>;
  aiJudge.mockResolvedValue({ taskId: 'any', feedback: 'ok' } satisfies SemanticJudgementResult);
  return {
    repository,
    provider: scenarioProvider(),
    taskIds: idSequence('task'),
    planIds: idSequence('plan'),
    aiJudge,
  };
}

function refresh(h: Harness, date: string, now: string): Promise<RefreshDailyPlanResult> {
  return refreshDailyPlanUseCase(
    {
      repository: h.repository,
      taskRepository: liveTaskRepository(h.repository),
      aiProvider: h.provider,
      newTaskId: h.taskIds,
      newPlanId: h.planIds,
      logger: silentLogger,
    },
    { learnerId, date, now },
  );
}

function settleAndRefresh(h: Harness, attemptId: string, now: string): Promise<SettleAndRefreshPlanResult> {
  return settleAndRefreshPlan(
    {
      repository: h.repository,
      aiJudge: { judge: h.aiJudge },
      taskRepository: liveTaskRepository(h.repository),
      aiProvider: h.provider,
      newTaskId: h.taskIds,
      newPlanId: h.planIds,
      logger: silentLogger,
    },
    { attemptId, judgedAt: now, now },
  );
}

function receiveAttempt(
  repository: RecordingStateRepository,
  task: Model.LearningTask,
  submission: Model.TaskSubmission,
  attemptId: string,
  receivedAt: string,
): void {
  const snapshot = repository.load();
  const result = Domain.recordTaskAttempt(snapshot.state, {
    attemptId,
    taskId: task.id,
    submission,
    validity: { elapsedMs: 5000, interrupted: false },
    receivedAt,
  });
  if (result.attempt.status !== 'received') throw new Error(`attempt not received: ${result.attempt.status}`);
  repository.save(result.state, snapshot.revision);
}

function taskByWord(h: Harness, planTaskIds: string[], wordId: string): Model.LearningTask {
  const state = h.repository.load().state;
  const task = planTaskIds
    .map((taskId) => state.tasks.find((item) => item.id === taskId))
    .find((item): item is Model.LearningTask => Boolean(item && item.content.wordId === wordId));
  if (!task) throw new Error(`plan 中没有 ${wordId} 的任务`);
  return task;
}

function planWords(h: Harness, planTaskIds: string[]): string[] {
  const state = h.repository.load().state;
  return planTaskIds.map((taskId) => state.tasks.find((item) => item.id === taskId)!.content.wordId);
}

/** 选择题提交：传 correct 决定选中正确/错误选项。 */
function choiceSubmission(task: Model.LearningTask, correct: boolean): Model.TaskSubmission {
  const content = task.content;
  if (content.task !== 'RETRIEVE' || content.content.stage !== 'choice') {
    throw new Error('expected a choice retrieve task');
  }
  const choice = content.content;
  const selectedOptionId = correct
    ? choice.answerOptionId
    : choice.options.find((option) => option.id !== choice.answerOptionId)!.id;
  return { task: 'RETRIEVE', stage: 'choice', selectedOptionId };
}

/** 阅读流利度提交：按目标速度构造 readingElapsedMs，选择题全对、自由题交卷。 */
function readingSubmission(task: Model.LearningTask, speedWpm: number): Model.TaskSubmission {
  const content = task.content;
  if (content.task !== 'FLUENCY' || content.content.axis !== 'R') {
    throw new Error('expected a reading fluency task');
  }
  const reading = content.content;
  const words = reading.passage.split(/\s+/).length;
  const readingElapsedMs = Math.round((words / speedWpm) * 60000);
  return {
    task: 'FLUENCY',
    axis: 'R',
    readingElapsedMs,
    answers: reading.questions.map((question) => question.kind === 'choice'
      ? { questionId: question.id, kind: 'choice' as const, selectedOptionId: question.answerOptionId }
      : { questionId: question.id, kind: 'free' as const, answer: 'The passage is about teams adapting to change.' }),
  };
}

/** AI 评判 mock：全部自由阅读题判对。 */
function judgeReadingCorrect(task: Model.LearningTask): SemanticJudgementResult {
  const content = task.content;
  if (content.task !== 'FLUENCY' || content.content.axis !== 'R') throw new Error('expected reading task');
  return {
    taskId: task.id,
    readingFreeQuestions: content.content.questions
      .filter((question) => question.kind === 'free')
      .map((question) => ({ questionId: question.id, correct: true })),
    feedback: '理解正确',
  };
}

function learningOf(h: Harness, wordId: string): Model.LearnerKnowledgePoint {
  return h.repository.load().state.learnerKnowledgePoints.find((item) => item.knowledgePointId === wordId)!;
}

// 把 contemporary 的 R 维调整为指定的毕业前复习状态（到期、未毕业）。
function withContemporaryReview(review: {
  intervalDays: number;
  successfulReviewStreak: number;
  dueAt: string;
}): (state: Model.LearningState) => void {
  return (state) => {
    state.learnerKnowledgePoints = state.learnerKnowledgePoints.map((item) =>
      item.knowledgePointId === 'kp-contemporary'
        ? {
          ...item,
          dimensions: {
            ...item.dimensions,
            R: {
              fluency: 85,
              review: {
                intervalDays: review.intervalDays,
                dueAt: review.dueAt,
                lastReviewedAt: '2026-11-05T00:00:00.000Z',
                successfulReviewStreak: review.successfulReviewStreak,
                lapseCount: 0,
                graduated: false,
              },
            },
          },
        }
        : item);
  };
}

describe('结算完自动更新计划场景', () => {
  test('答对（毕业前）：当天让位给新词，下次复习时计划升级为更高级任务', async () => {
    const h = harness();
    const first = await refresh(h, '2026-11-13', day.planned);
    if (!first.ok) throw new Error(`expected ok, got ${first.reason}`);
    const choiceTask = taskByWord(h, first.plan.taskIds, 'kp-ubiquitous');
    expect(choiceTask.content).toMatchObject({ task: 'RETRIEVE', content: { stage: 'choice' } });

    // 答对选择题：流利度 10 → 20，进入 cued 段；streak 1→2，复习间隔 1→3 天。
    receiveAttempt(h.repository, choiceTask, choiceSubmission(choiceTask, true), 'attempt-ubi-ok', day.answered);
    const result = await settleAndRefresh(h, 'attempt-ubi-ok', day.settled);
    expect(result.settlement.fluencyChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ knowledgePointId: 'kp-ubiquitous', dimension: 'R', before: 10, after: 20 }),
    ]));
    expect(learningOf(h, 'kp-ubiquitous').dimensions.R.review).toMatchObject({
      intervalDays: 3,
      dueAt: '2026-11-16T05:00:00.000Z',
    });
    if (!result.refresh.ok) throw new Error(`expected refresh ok, got ${result.refresh.reason}`);
    // 当天重排：该词 3 天后才到期，让出名额给等待中的新词 setback。
    expect(planWords(h, result.refresh.plan.taskIds)).not.toContain('kp-ubiquitous');
    expect(planWords(h, result.refresh.plan.taskIds)).toContain('kp-setback');
    expect(result.refresh.plan.taskIds).toHaveLength(5);

    // 时间推进到到期后重排：同一词以更高级的 cued 任务回到计划。
    const second = await refresh(h, '2026-11-16', day.review3Later);
    if (!second.ok) throw new Error(`expected ok, got ${second.reason}`);
    const upgraded = taskByWord(h, second.plan.taskIds, 'kp-ubiquitous');
    expect(upgraded.content).toMatchObject({ task: 'RETRIEVE', content: { axis: 'R', stage: 'cued' } });
  });

  test('答对 7 天间隔复习：下次复习排到 30 天后', async () => {
    const h = harness(withContemporaryReview({
      intervalDays: 7, successfulReviewStreak: 3, dueAt: '2026-11-12T22:00:00.000Z',
    }));
    const first = await refresh(h, '2026-11-13', day.planned);
    if (!first.ok) throw new Error(`expected ok, got ${first.reason}`);
    const readingTask = taskByWord(h, first.plan.taskIds, 'kp-contemporary');
    expect(readingTask.content).toMatchObject({ task: 'FLUENCY', content: { axis: 'R' } });

    h.aiJudge.mockImplementation(({ task }) => Promise.resolve(judgeReadingCorrect(task)));
    // 快速且全部答对（≥225 wpm，结算后流利度仍 ≥ 目标 80）：间隔 7 → 30 天。
    receiveAttempt(h.repository, readingTask, readingSubmission(readingTask, 240), 'attempt-cont-ok', day.answered);
    const result = await settleAndRefresh(h, 'attempt-cont-ok', day.settled);
    if (!result.refresh.ok) throw new Error(`expected refresh ok, got ${result.refresh.reason}`);
    const review = learningOf(h, 'kp-contemporary').dimensions.R.review;
    expect(review).toMatchObject({
      intervalDays: 30,
      dueAt: '2026-12-13T05:00:00.000Z',
      successfulReviewStreak: 4,
      graduated: false,
    });
    // 当天重排：该词 30 天后才到期，今天不再出现。
    expect(planWords(h, result.refresh.plan.taskIds)).not.toContain('kp-contemporary');

    // 30 天后到期重排：FLUENCY 复习回到计划。
    const later = await refresh(h, '2026-12-13', day.review30Later);
    if (!later.ok) throw new Error(`expected ok, got ${later.reason}`);
    const reviewTask = taskByWord(h, later.plan.taskIds, 'kp-contemporary');
    expect(reviewTask.content).toMatchObject({ task: 'FLUENCY', content: { axis: 'R' } });
  });

  test('答对最后 30 天复习：毕业后不再派发任务', async () => {
    const h = harness(withContemporaryReview({
      intervalDays: 30, successfulReviewStreak: 3, dueAt: '2026-11-12T22:00:00.000Z',
    }));
    const first = await refresh(h, '2026-11-13', day.planned);
    if (!first.ok) throw new Error(`expected ok, got ${first.reason}`);
    const readingTask = taskByWord(h, first.plan.taskIds, 'kp-contemporary');

    h.aiJudge.mockImplementation(({ task }) => Promise.resolve(judgeReadingCorrect(task)));
    receiveAttempt(h.repository, readingTask, readingSubmission(readingTask, 240), 'attempt-cont-grad', day.answered);
    const result = await settleAndRefresh(h, 'attempt-cont-grad', day.settled);
    if (!result.refresh.ok) throw new Error(`expected refresh ok, got ${result.refresh.reason}`);
    const review = learningOf(h, 'kp-contemporary').dimensions.R.review;
    expect(review.graduated).toBe(true);
    // 当天重排与 30 天后的重排都不再为该词派发任务：毕业即掌握。
    expect(planWords(h, result.refresh.plan.taskIds)).not.toContain('kp-contemporary');
    const later = await refresh(h, '2026-12-13', day.review30Later);
    if (!later.ok) throw new Error(`expected ok, got ${later.reason}`);
    expect(planWords(h, later.plan.taskIds)).not.toContain('kp-contemporary');
  });

  test('答错：当天重练并占住名额挤出新词，另一题答对后新词补位', async () => {
    const h = harness();
    const first = await refresh(h, '2026-11-13', day.planned);
    if (!first.ok) throw new Error(`expected ok, got ${first.reason}`);
    expect(planWords(h, first.plan.taskIds)).not.toContain('kp-setback');
    const choiceTask = taskByWord(h, first.plan.taskIds, 'kp-ubiquitous');

    // 答错：流利度回落到 5，复习间隔 0，当天到期重练。
    receiveAttempt(h.repository, choiceTask, choiceSubmission(choiceTask, false), 'attempt-ubi-bad', day.answered);
    const result = await settleAndRefresh(h, 'attempt-ubi-bad', day.settled);
    if (!result.refresh.ok) throw new Error(`expected refresh ok, got ${result.refresh.reason}`);
    expect(result.settlement.fluencyChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ knowledgePointId: 'kp-ubiquitous', dimension: 'R', before: 10, after: 5 }),
    ]));
    const review = learningOf(h, 'kp-ubiquitous').dimensions.R.review;
    expect(review).toMatchObject({ intervalDays: 0, dueAt: day.settled });
    // 当天重排：重练任务回到计划并占满容量，等待中的新词 setback 被挤出。
    const retryTask = taskByWord(h, result.refresh.plan.taskIds, 'kp-ubiquitous');
    expect(retryTask.id).not.toBe(choiceTask.id);
    expect(retryTask.content).toMatchObject({ task: 'RETRIEVE', content: { stage: 'choice' } });
    expect(result.refresh.plan.taskIds).toHaveLength(5);
    expect(planWords(h, result.refresh.plan.taskIds)).not.toContain('kp-setback');

    // 另一题答对：让出名额，新词补位。
    const readingTask = taskByWord(h, result.refresh.plan.taskIds, 'kp-contemporary');
    h.aiJudge.mockImplementation(({ task }) => Promise.resolve(judgeReadingCorrect(task)));
    const secondSettled = '2026-11-13T06:00:00.000Z';
    receiveAttempt(h.repository, readingTask, readingSubmission(readingTask, 240), 'attempt-cont-ok', secondSettled);
    const second = await settleAndRefresh(h, 'attempt-cont-ok', secondSettled);
    if (!second.refresh.ok) throw new Error(`expected refresh ok, got ${second.refresh.reason}`);
    expect(planWords(h, second.refresh.plan.taskIds)).toContain('kp-setback');
    expect(planWords(h, second.refresh.plan.taskIds)).not.toContain('kp-contemporary');
    expect(second.refresh.plan.taskIds).toHaveLength(5);
  });
});
