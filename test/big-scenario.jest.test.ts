/// <reference types="jest" />

/**
 * 端到端大场景（plan 文档第三节）：真实 S01～S12 用例 + 真实领域函数编排。
 *
 * 学习循环推进到目标内全部十个知识点的 R/P 双维度都达到 targetFluency 才退出；
 * 时间始终取自状态里的真实 dueAt，不硬编码日期。
 * AI 全部走 Fake（模板出题 / 固定评判），覆盖编排、失败路径与幂等；
 * 业务算法正确性由领域单测负责，本文件只验证用例衔接与状态往返。
 */

import { judgeAndSettleTaskAttempt } from '../lib/application/judge-settle-task-attempt';
import { addMaterialToGoalUseCase } from '../lib/application/goal-material';
import { changeLearningGoalStatusUseCase } from '../lib/application/goal-status';
import { importMaterialUseCase } from '../lib/application/material-import';
import { receiveTaskAttempt } from '../lib/application/receive-task-attempt';
import { refreshDailyPlanUseCase } from '../lib/application/refresh-daily-plan';
import { createLearnerUseCase } from '../lib/application/learner-settings';
import { selectKnowledgePointsUseCase } from '../lib/application/knowledge-point-selection';
import {
  startVocabularyAssessmentUseCase,
  submitVocabularyAssessmentUseCase,
} from '../lib/application/vocabulary-assessment';
import { localDateFor, planDailyStudy } from '../lib/domain/functions';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';
import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import {
  analyzerVersion,
  correctAnswerFor,
  dailyTaskCapacity,
  FakeTaskAIJudge,
  FakeTaskAIProvider,
  fakeSenseInventory,
  goalId,
  goalTitle,
  knowledgePointIdFor,
  learnerId,
  learnerTimezone,
  materialText,
  policyVersion,
  scenarioVocabularyFilter,
  scenarioWords,
  targetFluency,
  wrongChoiceAnswerFor,
} from './helpers/big-scenario-fixture';
import {
  emptyLearningState,
  InMemoryAppRepository,
  InMemoryVocabularyListRepository,
} from './helpers/in-memory-app-repository';
import { silentLogger } from './helpers/task-generation-fixture';

const list: Model.VocabularyListReference = {
  id: vocabularyFixture.source,
  version: vocabularyFixture.version,
};
const wordFamilies = vocabularyFixture.families.map((family) => ({
  ...family,
  band: family.band as Model.VocabularyBand,
}));
const bandWordFamilyCounts: Partial<Record<Model.VocabularyBand, number>> = {
  '1k': 1000,
  '2k': 1000,
  '3k': 1000,
  '4k': 1000,
};

const materialId = 'material-adapt';
const analysisId = 'analysis-adapt';
const assessmentId = 'assessment-1';

const T0 = Date.parse('2026-11-12T00:00:00.000Z');
const at = (offsetMinutes: number): string => new Date(T0 + offsetMinutes * 60_000).toISOString();

interface Ctx {
  repository: InMemoryAppRepository;
  provider: FakeTaskAIProvider;
  aiJudge: FakeTaskAIJudge;
  nextTaskId: () => string;
  nextAttemptId: () => string;
  vocabulary0: Model.VocabularyEstimate;
}

/** S01～S06：创建学习者 → 定级 → 导入分析 → 建目标 → 纳入并初始化十个知识点。 */
async function setupThroughS06(): Promise<Ctx> {
  const repository = new InMemoryAppRepository(emptyLearningState());
  const provider = new FakeTaskAIProvider();
  const aiJudge = new FakeTaskAIJudge();
  const listRepository = new InMemoryVocabularyListRepository(wordFamilies, bandWordFamilyCounts);
  let taskSeq = 0;
  let attemptSeq = 0;

  // S01：创建小林。
  const learner = createLearnerUseCase(repository, {
    id: learnerId,
    timezone: learnerTimezone,
    dailyTaskCapacity,
    now: at(0),
  });
  expect(learner.currentVocabulary).toBeNull();

  // S02：开始词汇自评定级（不调用 AI）。
  const started = await startVocabularyAssessmentUseCase(
    { repository, vocabularyListRepository: listRepository, logger: silentLogger },
    {
      learnerId,
      list,
      sampleCounts: { '1k': 1, '2k': 1, '3k': 1, '4k': 1 },
      seed: 'big-scenario-seed',
      assessmentId,
      taskIds: ['va-task-1', 'va-task-2', 'va-task-3', 'va-task-4'],
      now: at(1),
    },
  );
  if (!started.ok) throw new Error(`S02 失败：${started.reason}`);
  expect(started.tasks).toHaveLength(4);
  for (const task of started.tasks) {
    expect(Object.keys(task).sort()).toEqual(['band', 'id', 'knowledgePointId', 'lemma']);
  }
  expect(provider.requests).toHaveLength(0);

  // S03：提交全部 known 自评；最后一条重试验证幂等。
  for (let index = 0; index < 4; index++) {
    const attemptId = `va-attempt-${index + 1}`;
    const submitted = await submitVocabularyAssessmentUseCase(
      { repository, vocabularyListRepository: listRepository, logger: silentLogger },
      {
        assessmentId,
        taskId: `va-task-${index + 1}`,
        attemptId,
        known: true,
        answeredAt: at(2 + index),
        list,
      },
    );
    if (!submitted.ok) throw new Error(`S03 失败：${submitted.reason}`);
    if (submitted.status === 'in_progress') {
      expect(submitted.answered).toBe(index + 1);
    } else {
      expect(index).toBe(3);
      const retry = await submitVocabularyAssessmentUseCase(
        { repository, vocabularyListRepository: listRepository, logger: silentLogger },
        {
          assessmentId,
          taskId: 'va-task-4',
          attemptId,
          known: true,
          answeredAt: at(5),
          list,
        },
      );
      expect(retry).toEqual(submitted);
    }
  }
  const stateAfterAssessment = repository.load().state;
  const assessedLearner = stateAfterAssessment.learners.find((item) => item.id === learnerId)!;
  const vocabulary0 = assessedLearner.currentVocabulary!;
  expect(vocabulary0).not.toBeNull();
  expect(stateAfterAssessment.vocabularyAssessmentAttempts).toHaveLength(4);
  const completed = stateAfterAssessment.vocabularyAssessments.find(
    (item) => item.id === assessmentId,
  ) as Extract<Model.VocabularyAssessment, { status: 'completed' }>;
  expect(completed.status).toBe('completed');
  expect(completed.result).toBe(vocabulary0);

  // S04：导入并分析材料（单义词义库，不经 AI 消歧）。
  const imported = await importMaterialUseCase(
    {
      repository,
      senseInventory: fakeSenseInventory,
      vocabularyFilter: scenarioVocabularyFilter,
      logger: silentLogger,
    },
    {
      materialId,
      analysisId,
      learnerId,
      filename: 'how-teams-adapt.md',
      extractedText: materialText,
      analyzerVersion,
      now: at(10),
    },
  );
  if (!imported.ok) throw new Error(`S04 失败：${imported.reason}`);
  expect(imported.analysis.items).toHaveLength(10);
  expect(imported.analysis.unmatchedItems.length).toBeGreaterThan(0);
  const deliberate = imported.analysis.items.find(
    (item) => item.knowledgePoint.kind === 'word' && item.knowledgePoint.lemma === 'deliberate',
  )!;
  expect(deliberate.knowledgePoint.sense.definition).toBe('深思熟虑的');

  // S05：创建目标并加入固定分析版本。
  const scoped = await addMaterialToGoalUseCase(
    { repository, logger: silentLogger },
    {
      goalId,
      learnerId,
      title: goalTitle,
      targetFluency,
      materialId,
      analysisId,
      addedAt: at(11),
      now: at(11),
    },
  );
  if (!scoped.ok) throw new Error(`S05 失败：${scoped.reason}`);
  expect(scoped.candidates).toHaveLength(10);

  // S06：纳入全部十个候选并初始化。
  const selected = await selectKnowledgePointsUseCase(
    { repository, logger: silentLogger },
    {
      goalId,
      selections: scenarioWords.map((word) => ({
        knowledgePointId: knowledgePointIdFor(word.lemma),
        selection: 'included' as const,
      })),
      policyVersion,
      now: at(12),
    },
  );
  if (!selected.ok) throw new Error(`S06 失败：${selected.reason}`);
  expect(selected.initialized).toHaveLength(10);

  const state = repository.load().state;
  expect(validateLearningState(state)).toEqual([]);
  expect(state.studyPlans).toHaveLength(0);
  expect(state.tasks).toHaveLength(0);

  return {
    repository,
    provider,
    aiJudge,
    nextTaskId: () => `task-${++taskSeq}`,
    nextAttemptId: () => `attempt-${++attemptSeq}`,
    vocabulary0,
  };
}

function learningsOf(state: Model.LearningState): Model.LearnerKnowledgePoint[] {
  return state.learnerKnowledgePoints.filter((item) => item.learnerId === learnerId);
}

/** 循环退出条件：全部知识点的 R/P 维度都复习毕业（走完 30 天间隔毕业复习）。 */
function allGraduated(state: Model.LearningState): boolean {
  const learnings = learningsOf(state);
  return learnings.length === scenarioWords.length
    && learnings.every((learning) =>
      (['R', 'P'] as const).every(
        (dimension) => learning.dimensions[dimension].review.graduated,
      ));
}

/** 推进到当前状态最早的、尚未到期的复习时间之后。 */
function nextStudyTime(state: Model.LearningState, now: string): string {
  const nowMs = Date.parse(now);
  const futureDues = learningsOf(state)
    .flatMap((learning) => [learning.dimensions.R.review, learning.dimensions.P.review])
    .filter((review) => !review.graduated)
    .map((review) => Date.parse(review.dueAt))
    .filter((dueMs) => dueMs > nowMs);
  if (futureDues.length === 0) {
    return new Date(nowMs + 86_400_000).toISOString();
  }
  return new Date(Math.min(...futureDues) + 60_000).toISOString();
}

function requiresSemanticJudgement(task: Model.LearningTask): boolean {
  const content = task.content;
  if (content.task === 'ENCODE') return false;
  if (content.task === 'RETRIEVE') return content.content.stage !== 'choice';
  return content.content.axis === 'P'
    || content.content.questions.some((question) => question.kind === 'free');
}

function signatureOf(task: Model.LearningTask): string {
  const content = task.content;
  if (content.task === 'ENCODE') return 'ENCODE';
  if (content.task === 'RETRIEVE') {
    return `RETRIEVE-${content.content.axis}-${content.content.stage}`;
  }
  return `FLUENCY-${content.content.axis}`;
}

/** 从初始流利度推导必须出现过的任务类型（起始分不同，必经路径不同）。 */
function expectedSignatures(initial: Model.LearnerKnowledgePoint[]): Set<string> {
  const expected = new Set<string>(['FLUENCY-R', 'FLUENCY-P']);
  for (const learning of initial) {
    for (const dimension of ['R', 'P'] as const) {
      const fluency = learning.dimensions[dimension].fluency;
      if (fluency <= 0) expected.add('ENCODE');
      if (fluency < 20) expected.add(`RETRIEVE-${dimension}-choice`);
      if (fluency < 40) expected.add(`RETRIEVE-${dimension}-cued`);
      if (fluency < 60) expected.add(`RETRIEVE-${dimension}-free`);
    }
  }
  return expected;
}

function expectViewHasNoAnswers(view: unknown): void {
  const serialized = JSON.stringify(view);
  for (const forbidden of [
    'answerOptionId',
    'answerKey',
    'gradingRequirements',
    'explanation',
    'evidence',
    'acceptedAnswers',
    'targetOccurrences',
    '"answer"',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
}

async function refreshPlan(ctx: Ctx, now: string) {
  return refreshDailyPlanUseCase(
    {
      repository: ctx.repository,
      taskRepository: ctx.repository,
      aiProvider: ctx.provider,
      newTaskId: ctx.nextTaskId,
      logger: silentLogger,
    },
    { learnerId, date: localDateFor(now, learnerTimezone), now },
  );
}

describe('端到端大场景', () => {
  test(
    '十个知识点从定级到全部毕业，再归档目标',
    async () => {
      const ctx = await setupThroughS06();
      const expectEncode = expectedSignatures(learningsOf(ctx.repository.load().state)).has('ENCODE');
      const expected = expectedSignatures(learningsOf(ctx.repository.load().state));
      const seen = new Set<string>();
      let ubiquitousWrongAnswered = false;
      let idempotencyChecked = false;
      let judgeFailureChecked = false;
      let firstDay = true;
      let days = 0;
      const studiedDates = new Set<string>();
      let now = at(20);

      // ── 学习循环（plan 步骤 7～12）：每个学习日重复 7～11，直到全部知识点毕业 ──
      // S07～S09 由 R1（refreshDailyPlanUseCase）一次编排完成：
      // S07 真实 planDailyStudy 产出暂态决策（不落库），S08 为每个 new 规格
      // 调用 Fake AI 生成题目，任一失败整体不落库，S09 把计划与任务一起持久化。
      while (!allGraduated(ctx.repository.load().state)) {
        days += 1;
        if (days > 600) {
          throw new Error(`学习循环 ${days} 天仍未全部毕业，疑似死循环`);
        }

        // 学习日：每答完一题、结算完成后立即重新排期（R2 语义）。
        // 后续任务一律以最新计划为准——serverTasks 不是按天/按批快照，
        // 在途任务随每次结算刷新；同词另一维度升级、答错词当天重试由此自然发生。
        let sessionNow = now;
        while (true) {
          const refreshed = await refreshPlan(ctx, sessionNow);
          if (!refreshed.ok) throw new Error(`每日计划刷新失败：${refreshed.reason}`);
          studiedDates.add(refreshed.plan.date);
          // 容量语义：每日容量约束的是"同时在途任务数"，每次排期不超过容量；
          // 公开视图不含答案/证据/评分标准。
          expect(refreshed.plan.taskIds.length).toBeLessThanOrEqual(dailyTaskCapacity);
          expect(refreshed.tasks).toHaveLength(refreshed.plan.taskIds.length);
          for (const view of refreshed.tasks) expectViewHasNoAnswers(view);
          if (refreshed.plan.taskIds.length === 0) break;

          // 公开视图不带答案，作答要从 Repository 重新加载的服务端任务构造。
          const state = ctx.repository.load().state;
          const serverTasks = refreshed.plan.taskIds.map(
            (taskId) => state.tasks.find((task) => task.id === taskId)!,
          );
          if (firstDay) {
            firstDay = false;
            // 首轮结构属性：不含 FLUENCY（初始分上限低于 60 门槛），且不超容量；
            // 初始分全 0 时首轮全部是 ENCODE（当前实现），否则全部是 RETRIEVE。
            expect(serverTasks.every((task) => task.content.task !== 'FLUENCY')).toBe(true);
            if (expectEncode) {
              expect(serverTasks.every((task) => task.content.task === 'ENCODE')).toBe(true);
            } else {
              expect(serverTasks.every((task) => task.content.task === 'RETRIEVE')).toBe(true);
            }
            for (const request of ctx.provider.requests) {
              expect(request.learnerVocabulary).toEqual(ctx.vocabulary0);
            }
          }

          // 只作答当前计划内的一道题；其余在途任务在下次刷新后继续。
          // ── S10：接收学习任务作答（只记原始答案，不碰流利度/复习计划）──
          const task = serverTasks[0];
          seen.add(signatureOf(task));
          // 作答策略：全部答对；ubiquitous 首次出现的 RETRIEVE 选择题故意答错一次，
          // 验证失败路径（赋 5 分、间隔清零、当天重练）与真实评判保留。
          const isUbiquitousChoice = task.content.wordId === knowledgePointIdFor('ubiquitous')
            && task.content.task === 'RETRIEVE'
            && task.content.content.stage === 'choice';
          const prepared = isUbiquitousChoice && !ubiquitousWrongAnswered
            ? wrongChoiceAnswerFor(task)
            : correctAnswerFor(task);
          if (isUbiquitousChoice && !ubiquitousWrongAnswered) ubiquitousWrongAnswered = true;

          // 逐题日志：捕获做前分数（词、任务类型、评判结果在做后打印）。
          const wordLemma = task.content.wordId.split(':')[1];
          const learningBefore = ctx.repository.load().state.learnerKnowledgePoints.find(
            (item) => item.learnerId === learnerId && item.knowledgePointId === task.content.wordId,
          )!;
          const beforeScores = {
            R: learningBefore.dimensions.R.fluency,
            P: learningBefore.dimensions.P.fluency,
          };

          const attemptId = ctx.nextAttemptId();
          const received = receiveTaskAttempt(ctx.repository, {
            attemptId,
            taskId: task.id,
            submission: prepared.submission,
            validity: prepared.validity,
            receivedAt: sessionNow,
          }, silentLogger);
          expect(received.status).toBe('received');

          // S10 幂等：同一 attemptId 重试不产生第二条作答。
          if (!idempotencyChecked) {
            idempotencyChecked = true;
            const retry = receiveTaskAttempt(ctx.repository, {
              attemptId,
              taskId: task.id,
              submission: prepared.submission,
              validity: prepared.validity,
              receivedAt: sessionNow,
            }, silentLogger);
            expect(retry).toBe(received);
            expect(
              ctx.repository.load().state.attempts.filter((item) => item.id === attemptId),
            ).toHaveLength(1);
          }

          // ── S11：评判并结算（Domain 统一结算，应用层不算分）──
          // 选择题与 ENCODE 走规则评判；RETRIEVE cued/free、阅读 free 问题、
          // P 场景表达由应用层调用 Fake AI Judge，以 judgedBy='ai' 进入同一结算路径。
          // AI 评判失败时保留作答（状态停在 judging），不伪造规则结果，可原样重试。
          if (!judgeFailureChecked && requiresSemanticJudgement(task)) {
            judgeFailureChecked = true;
            ctx.aiJudge.failNext = true;
            await expect(
              judgeAndSettleTaskAttempt(
                ctx.repository,
                ctx.aiJudge,
                { attemptId, judgedAt: sessionNow, now: sessionNow },
                silentLogger,
              ),
            ).rejects.toThrow('Fake AI judge failure');
            const afterFailure = ctx.repository.load().state.attempts.find(
              (item) => item.id === attemptId,
            )!;
            expect(afterFailure.status).toBe('judging');
          }

          const settled = await judgeAndSettleTaskAttempt(
            ctx.repository,
            ctx.aiJudge,
            { attemptId, judgedAt: sessionNow, now: sessionNow },
            silentLogger,
          );

          // S11 幂等：重试返回同一结算，不重复结算。
          const settledAttempt = ctx.repository.load().state.attempts.find(
            (item) => item.id === attemptId,
          )!;
          expect(settledAttempt.status).toBe('settled');
          const retrySettle = await judgeAndSettleTaskAttempt(
            ctx.repository,
            ctx.aiJudge,
            { attemptId, judgedAt: sessionNow, now: sessionNow },
            silentLogger,
          );
          expect(retrySettle.settlement.settledAt).toBe(settled.settlement.settledAt);
          expect(
            ctx.repository.load().state.attempts.filter((item) => item.id === attemptId),
          ).toHaveLength(1);

          if (requiresSemanticJudgement(task)) {
            expect(settledAttempt.judgement!.judgedBy).toBe('ai');
            expect(ctx.aiJudge.judged.some((item) => item.taskId === task.id)).toBe(true);
          } else {
            expect(settledAttempt.judgement!.judgedBy).toBe('rule');
          }
          const taskAfter = ctx.repository.load().state.tasks.find((item) => item.id === task.id)!;
          expect(taskAfter.status).toBe('completed');
          // 逐题日志：任务类型、词、做前/做后分数、评判结果与评判方式。
          const learningAfter = ctx.repository.load().state.learnerKnowledgePoints.find(
            (item) => item.learnerId === learnerId && item.knowledgePointId === task.content.wordId,
          )!;
          const judged = settledAttempt.judgement!.dimensions;
          const outcomeText = judged.R && judged.P
            ? `R:${judged.R.outcome} P:${judged.P.outcome}`
            : judged.R
              ? `R:${judged.R.outcome}`
              : `P:${judged.P!.outcome}`;
          console.log(
            `[学习日${String(days).padStart(3)} ${refreshed.plan.date}] `
            + `${signatureOf(task).padEnd(18)} ${wordLemma.padEnd(12)} `
            + `做前 R${beforeScores.R}/P${beforeScores.P} → `
            + `做后 R${learningAfter.dimensions.R.fluency}/P${learningAfter.dimensions.P.fluency} | `
            + `评判 ${outcomeText} (${settledAttempt.judgement!.judgedBy})`,
          );
          sessionNow = new Date(Date.parse(sessionNow) + 60_000).toISOString();
        }

        // ── 学习日收尾：状态约束校验 + 时间推进 ──
        // 下一个学习日 = 当前状态最早的未来复习到期时间（含毕业前 +1/+3/+7/+30
        // 的达标复习链）；到期复习完全由下一次 S07～S09 驱动。
        const afterDay = ctx.repository.load().state;
        expect(validateLearningState(afterDay)).toEqual([]);
        now = nextStudyTime(afterDay, now);
      }

      // 循环退出即验收：全部维度复习毕业、路径覆盖、答错保真。
      // 毕业要求走完达标后的 +1/+3/+7/+30 天 FLUENCY 复习链；按日历跨度断言
      //（外层迭代数不等于天数，nextStudyTime 会一次跳到 30 天后的到期复习）。
      const elapsedDays = (Date.parse(now) - Date.parse(at(20))) / 86_400_000;
      expect(elapsedDays).toBeGreaterThan(41);
      for (const signature of expected) {
        expect(seen.has(signature)).toBe(true);
      }
      expect(ubiquitousWrongAnswered).toBe(true);

      const finalState = ctx.repository.load().state;
      const settledAttempts = finalState.attempts.filter((item) => item.status === 'settled');
      const completedTasks = finalState.tasks.filter((item) => item.status === 'completed');
      expect(settledAttempts.length).toBeGreaterThanOrEqual(scenarioWords.length * 2);
      expect(completedTasks).toHaveLength(settledAttempts.length);
      const wrongAttempt = settledAttempts.find(
        (item) => item.judgement?.dimensions.R?.outcome === 'incorrect',
      )!;
      const wrongTask = finalState.tasks.find((task) => task.id === wrongAttempt.taskId)!;
      expect(wrongTask.content.wordId).toBe(knowledgePointIdFor('ubiquitous'));

      // 退出条件验收：十个知识点的 R/P 维度全部 graduated，且流利度不低于目标。
      for (const learning of learningsOf(finalState)) {
        for (const dimension of ['R', 'P'] as const) {
          expect(learning.dimensions[dimension].review.graduated).toBe(true);
          expect(learning.dimensions[dimension].fluency)
            .toBeGreaterThanOrEqual(targetFluency[dimension]);
        }
      }

      // S12：归档目标后不再生成该目标的新任务，历史全部保留。
      changeLearningGoalStatusUseCase(ctx.repository, { goalId, status: 'archived', now });
      const archivedNow = new Date(Date.parse(now) + 86_400_000 * 2).toISOString();
      const afterArchive = await refreshPlan(ctx, archivedNow);
      if (!afterArchive.ok) throw new Error(`归档后排期失败：${afterArchive.reason}`);
      expect(afterArchive.plan.taskIds).toHaveLength(0);
      const history = ctx.repository.load().state;
      expect(history.tasks.filter((task) => task.status === 'completed')).toHaveLength(completedTasks.length);
      expect(history.tasks.every((task) => task.status === 'completed' || task.status === 'cancelled')).toBe(true);
      expect(history.attempts).toHaveLength(settledAttempts.length);
      // 答对当天升级：同一学习日可能多次重排，计划按 (learner, date) 保存；
      // 每个学习日都有对应日期的计划，且存在跨多个学习日的计划。
      const persistedDates = new Set(history.studyPlans.map((item) => item.date));
      for (const date of studiedDates) {
        expect(persistedDates.has(date)).toBe(true);
      }
      expect(persistedDates.size).toBeGreaterThan(3);
      expect(validateLearningState(history)).toEqual([]);
    },
    120_000,
  );

  test('S08 生成失败时整体失败且不落任何状态，恢复后可重试成功', async () => {
    const ctx = await setupThroughS06();
    const revisionBefore = ctx.repository.load().revision;
    ctx.provider.failNext = true;

    const failed = await refreshPlan(ctx, at(20));
    expect(failed).toEqual({ ok: false, reason: 'task_generation_failed' });
    const afterFailure = ctx.repository.load();
    expect(afterFailure.revision).toBe(revisionBefore);
    expect(afterFailure.state.studyPlans).toHaveLength(0);
    expect(afterFailure.state.tasks).toHaveLength(0);
    expect(validateLearningState(afterFailure.state)).toEqual([]);

    const recovered = await refreshPlan(ctx, at(21));
    if (!recovered.ok) throw new Error(`恢复后刷新失败：${recovered.reason}`);
    expect(recovered.plan.taskIds.length).toBeGreaterThan(0);
    expect(validateLearningState(ctx.repository.load().state)).toEqual([]);
  });

  test('S07 排期是暂态决策：不创建任务或计划，不修改状态', async () => {
    const ctx = await setupThroughS06();
    const before = ctx.repository.load();
    const decision = planDailyStudy(before.state, {
      learnerId,
      date: '2026-11-12',
      now: at(20),
    });
    expect(decision.taskCapacity).toBe(dailyTaskCapacity);
    expect(decision.tasks.length).toBeGreaterThan(0);
    expect(decision.tasks.every((position) => position.source === 'new')).toBe(true);

    const after = ctx.repository.load();
    expect(after.revision).toBe(before.revision);
    expect(after.state.studyPlans).toHaveLength(0);
    expect(after.state.tasks).toHaveLength(0);
    expect(validateLearningState(after.state)).toEqual([]);
  });
});
