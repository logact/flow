/// <reference types="jest" />

/**
 * S09 应用排期决策并保存每日计划的应用用例测试。
 * 使用内存状态仓库与 Fake AI Provider，并注入静默 logger：
 * - 验证编排：真实 S07 决策 + 真实 S08 任务经一次乐观锁写入，返回按决策顺序的公开视图。
 * - 验证原子性：过期/取消状态变化与新计划同一次保存；任何校验失败零写入。
 * - 验证并发：保存窗口内状态被并发修改时返回冲突，提示从排期决策重新执行。
 * 不验证：S07 决策算法本身（领域测试覆盖）、AI 供应商真实调用（Live 验证另行进行）。
 */

import { applyDailyPlanUseCase } from '../lib/application/apply-daily-plan';
import type { AppLogger } from '../lib/application/logger';
import {
  judgeTask,
  recordTaskAttempt,
  settleTaskAttempt,
  updateLearnerSettings,
} from '../lib/domain/functions';
import type { DailyStudyDecision, TaskSpecification } from '../lib/domain/functions';
import type * as Model from '../lib/domain/model';
import {
  at,
  decisionTaskIds,
  idForSpec,
  makeCompletedTask,
  makeIssuedTask,
  planAndGenerate,
  planDate,
  setup,
  silentLogger,
  yesterday,
} from './helpers/apply-daily-plan-fixture';
import { goalId, learnerId } from './helpers/task-generation-fixture';

type LogEntry = { level: string; msg: string } & Record<string, unknown>;

function captureLogger(entries: LogEntry[]): AppLogger {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    entries.push({ level, msg, ...obj });
  };
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

type ApplyResult = Awaited<ReturnType<typeof applyDailyPlanUseCase>>;

function expectOk(result: ApplyResult) {
  if (!result.ok) throw new Error(`期望应用成功，实际失败：${result.reason}`);
  return result;
}

function contentRecord(view: Model.LearningTaskView): Record<string, unknown> {
  return view.content.content as unknown as Record<string, unknown>;
}

function expectUnchanged(repository: ReturnType<typeof setup>['repository'], state: Model.LearningState) {
  expect(repository.saveAttempts).toBe(0);
  expect(repository.load().state).toEqual(state);
}

const encodeSpec: TaskSpecification = { goalId, wordId: 'kp-resilient', task: 'ENCODE' };

function baseDecision(overrides: Partial<DailyStudyDecision> = {}): DailyStudyDecision {
  return {
    learnerId,
    date: planDate,
    taskCapacity: 5,
    tasks: [{ source: 'new', specification: encodeSpec }],
    expireTaskIds: [],
    cancelTaskIds: [],
    ...overrides,
  };
}

async function applyHandCrafted(
  repository: ReturnType<typeof setup>['repository'],
  input: Parameters<typeof applyDailyPlanUseCase>[1],
) {
  return applyDailyPlanUseCase({ repository, logger: silentLogger }, input);
}

describe('S09 应用排期决策并保存每日计划', () => {
  test('P1 首次保存：计划摘要、任务顺序与视图脱敏', async () => {
    const { repository, provider } = setup();
    const { decision, newTasks } = await planAndGenerate(repository, provider, planDate, at.planned);
    expect(decision.tasks).toHaveLength(5);
    expect(decision.tasks.every((position) => position.source === 'new')).toBe(true);

    const result = expectOk(await applyDailyPlanUseCase(
      { repository, logger: silentLogger },
      { planId: 'plan-day-1', decision, newTasks, now: at.planned },
    ));

    const expectedIds = decisionTaskIds(decision, newTasks);
    expect(result.plan).toEqual({
      id: 'plan-day-1',
      learnerId,
      date: planDate,
      taskCapacity: 5,
      taskIds: expectedIds,
      createdAt: at.planned,
      updatedAt: at.planned,
    });
    expect(result.tasks.map((view) => view.id)).toEqual(expectedIds);
    expect(repository.saveAttempts).toBe(1);

    const after = repository.load().state;
    expect(after.studyPlans).toHaveLength(1);
    expect(after.tasks.filter((task) => task.status === 'issued')).toHaveLength(5);

    // RETRIEVE 选择题：公开视图剥离答案与解释。
    const choice = result.tasks.find((view) => view.content.task === 'RETRIEVE'
      && (view.content.content as { stage: string }).stage === 'choice')!;
    expect(contentRecord(choice)).not.toHaveProperty('answerOptionId');
    expect(contentRecord(choice)).not.toHaveProperty('explanation');
    // RETRIEVE 提示题：公开视图剥离答案键，保留提示。
    const cued = result.tasks.find((view) => view.content.task === 'RETRIEVE'
      && (view.content.content as { stage: string }).stage === 'cued')!;
    expect(contentRecord(cued)).not.toHaveProperty('answerKey');
    expect(contentRecord(cued)).toHaveProperty('cue');
    // FLUENCY-R：公开视图剥离证据句与自由题答案。
    const reading = result.tasks.find((view) => view.content.task === 'FLUENCY'
      && (view.content.content as { axis: string }).axis === 'R')!;
    expect(contentRecord(reading)).toHaveProperty('passage');
    for (const question of (contentRecord(reading).questions as Array<Record<string, unknown>>)) {
      expect(question).not.toHaveProperty('answer');
      expect(question).not.toHaveProperty('evidence');
      expect(question).not.toHaveProperty('answerOptionId');
    }
    // FLUENCY-P：公开视图剥离评分标准，保留场景与作答要求。
    const production = result.tasks.find((view) => view.content.task === 'FLUENCY'
      && (view.content.content as { axis: string }).axis === 'P')!;
    expect(contentRecord(production)).not.toHaveProperty('gradingRequirements');
    expect(contentRecord(production)).toHaveProperty('scenario');
    // ENCODE：示例本来就公开。
    const encode = result.tasks.find((view) => view.content.task === 'ENCODE')!;
    expect(contentRecord(encode)).toHaveProperty('examples');
  });

  test('P2 同日二次应用：计划原地更新，existing 保留原任务，落选候选补位', async () => {
    const { repository, provider } = setup();
    const first = await planAndGenerate(repository, provider, planDate, at.planned);
    expectOk(await applyDailyPlanUseCase(
      { repository, logger: silentLogger },
      { planId: 'plan-day-1', decision: first.decision, newTasks: first.newTasks, now: at.planned },
    ));

    // 将 resilient-b 移出学习范围，空出的位置由第一轮因容量落选的 setback 补位。
    const snapshot = repository.load();
    const state = snapshot.state;
    const nextState: Model.LearningState = {
      ...state,
      goalKnowledgePoints: state.goalKnowledgePoints.map((candidate) =>
        candidate.knowledgePointId === 'kp-resilient-b'
          ? { ...candidate, selection: 'excluded' as const }
          : candidate),
    };
    repository.save(nextState, snapshot.revision);

    const second = await planAndGenerate(repository, provider, planDate, at.replanned);
    const resilientBTaskId = idForSpec({ goalId, wordId: 'kp-resilient-b', task: 'FLUENCY', axis: 'P' });
    expect(second.decision.cancelTaskIds).toEqual([resilientBTaskId]);
    expect(second.newTasks).toHaveLength(1);
    expect(second.newTasks[0].id).toBe(idForSpec({ goalId, wordId: 'kp-setback', task: 'ENCODE' }));

    // 第二次应用省略 planId：复用当天已有计划，保留 createdAt。
    const result = expectOk(await applyDailyPlanUseCase(
      { repository, logger: silentLogger },
      { decision: second.decision, newTasks: second.newTasks, now: at.replanned },
    ));
    expect(result.plan.id).toBe('plan-day-1');
    expect(result.plan.createdAt).toBe(at.planned);
    expect(result.plan.updatedAt).toBe(at.replanned);
    expect(result.plan.taskIds).toEqual(decisionTaskIds(second.decision, second.newTasks));
    expect(result.tasks.map((view) => view.id)).toEqual(result.plan.taskIds);

    const after = repository.load().state;
    expect(after.tasks.find((task) => task.id === resilientBTaskId)?.status).toBe('cancelled');
    expect(after.tasks.find((task) => task.id === second.newTasks[0].id)?.status).toBe('issued');
    expect(after.studyPlans).toHaveLength(1);
    // 第二轮只为 setback 调用一次 AI。
    expect(provider.requests).toHaveLength(6);
  });

  test('P3 过期与取消：状态变化与新计划在同一次写入中保存', async () => {
    const { repository, provider } = setup((state) => {
      state.studyPlans.push({
        id: 'plan-yesterday',
        learnerId,
        date: yesterday,
        taskCapacity: 5,
        taskIds: ['task-old'],
        createdAt: at.created,
        updatedAt: at.created,
      });
      state.tasks.push(makeIssuedTask('task-old', 'kp-ubiquitous', '2026-11-12T01:00:00.000Z'));
      state.goalKnowledgePoints.push({
        goalId,
        knowledgePointId: 'kp-drop',
        selection: 'excluded',
        addedAt: at.created,
        selectionUpdatedAt: at.created,
      });
      state.tasks.push(makeIssuedTask('task-drop', 'kp-drop', '2026-11-12T02:00:00.000Z'));
    });
    const { decision, newTasks } = await planAndGenerate(repository, provider, planDate, at.planned);
    expect(decision.expireTaskIds).toEqual(['task-old']);
    expect(decision.cancelTaskIds).toEqual(['task-drop']);

    const result = expectOk(await applyDailyPlanUseCase(
      { repository, logger: silentLogger },
      { planId: 'plan-day-1', decision, newTasks, now: at.planned },
    ));

    expect(repository.saveAttempts).toBe(1);
    expect(result.plan.taskIds).toHaveLength(5);
    const after = repository.load().state;
    expect(after.tasks.find((task) => task.id === 'task-old')?.status).toBe('expired');
    expect(after.tasks.find((task) => task.id === 'task-drop')?.status).toBe('cancelled');
    expect(after.tasks.filter((task) => task.status === 'issued')).toHaveLength(5);
  });

  test('P4 只写当日计划：历史计划不被改动', async () => {
    const yesterdayPlan = {
      id: 'plan-yesterday',
      learnerId,
      date: yesterday,
      taskCapacity: 5,
      taskIds: [] as string[],
      createdAt: at.created,
      updatedAt: at.created,
    };
    const { repository, provider } = setup((state) => {
      state.studyPlans.push(yesterdayPlan);
    });
    const { decision, newTasks } = await planAndGenerate(repository, provider, planDate, at.planned);
    expectOk(await applyDailyPlanUseCase(
      { repository, logger: silentLogger },
      { planId: 'plan-day-1', decision, newTasks, now: at.planned },
    ));

    const after = repository.load().state;
    expect(after.studyPlans).toHaveLength(2);
    expect(after.studyPlans.find((plan) => plan.date === yesterday)).toEqual(yesterdayPlan);
  });

  test('P5 同日二次应用：容量缩减重排，已结算任务不再排入，保留任务复用原 ID', async () => {
    const { repository, provider } = setup();
    const first = await planAndGenerate(repository, provider, planDate, at.planned);
    expectOk(await applyDailyPlanUseCase(
      { repository, logger: silentLogger },
      { planId: 'plan-day-1', decision: first.decision, newTasks: first.newTasks, now: at.planned },
    ));

    // 学习者完成 ubiquitous 选择题并结算。
    const snapshot = repository.load();
    let state = snapshot.state;
    const ubiquitousSpec: TaskSpecification = {
      goalId, wordId: 'kp-ubiquitous', task: 'RETRIEVE', axis: 'R', stage: 'choice',
    };
    const ubiquitousTaskId = idForSpec(ubiquitousSpec);
    const submission: Model.TaskSubmission = {
      task: 'RETRIEVE', stage: 'choice', selectedOptionId: 'a',
    };
    const recorded = recordTaskAttempt(state, {
      attemptId: 'attempt-ubiquitous-1',
      taskId: ubiquitousTaskId,
      submission,
      validity: { interrupted: false, elapsedMs: 12000 },
      receivedAt: at.answered,
    });
    state = recorded.state;
    const judged = judgeTask({
      task: state.tasks.find((task) => task.id === ubiquitousTaskId)!,
      submission: recorded.attempt.submission,
      judgedAt: at.answered,
    });
    state = settleTaskAttempt(state, { attemptId: 'attempt-ubiquitous-1', judgement: judged, now: at.answered }).state;

    // 容量 5 缩减为 3 后同日重排。
    state = {
      ...state,
      learners: state.learners.map((item) =>
        item.id === learnerId ? updateLearnerSettings(item, { dailyTaskCapacity: 3, now: at.replanned }) : item),
    };
    repository.save(state, snapshot.revision);

    const second = await planAndGenerate(repository, provider, planDate, at.replanned);
    const encodeTaskId = idForSpec(encodeSpec);
    expect(second.newTasks).toHaveLength(0);
    expect(second.decision.tasks.every((position) => position.source === 'existing')).toBe(true);
    expect(second.decision.cancelTaskIds).toEqual([encodeTaskId]);

    const result = expectOk(await applyDailyPlanUseCase(
      { repository, logger: silentLogger },
      { decision: second.decision, newTasks: second.newTasks, now: at.replanned },
    ));
    expect(result.plan.id).toBe('plan-day-1');
    expect(result.plan.createdAt).toBe(at.planned);
    expect(result.plan.updatedAt).toBe(at.replanned);
    expect(result.plan.taskCapacity).toBe(3);
    expect(result.plan.taskIds).toEqual(decisionTaskIds(second.decision, second.newTasks));
    // 保留的 three 个任务全部复用第一轮 ID。
    expect(result.plan.taskIds).toHaveLength(3);
    for (const taskId of result.plan.taskIds) {
      expect(first.newTasks.some((task) => task.id === taskId)).toBe(true);
    }

    const after = repository.load().state;
    // 已完成任务保持完成，不再出现在新计划中。
    const settledTask = after.tasks.find((task) => task.id === ubiquitousTaskId)!;
    expect(settledTask.status).toBe('completed');
    expect(result.plan.taskIds).not.toContain(ubiquitousTaskId);
    // 容量装不下的新词任务被显式取消。
    expect(after.tasks.find((task) => task.id === encodeTaskId)?.status).toBe('cancelled');
    // 第二轮没有新规格，零 AI 调用。
    expect(provider.requests).toHaveLength(5);
  });

  test('F1 new 位置数量与任务数量不符时不保存（缺失与多余）', async () => {
    const { repository } = setup();
    const state = repository.load().state;
    const decision = baseDecision();
    const missing = await applyHandCrafted(repository, {
      planId: 'plan-hand', decision, newTasks: [], now: at.planned,
    });
    expect(missing).toEqual({ ok: false, reason: 'invalid_decision' });

    const setbackSpec: TaskSpecification = { goalId, wordId: 'kp-setback', task: 'ENCODE' };
    const extra = await applyHandCrafted(repository, {
      planId: 'plan-hand',
      decision: baseDecision({
        tasks: [
          { source: 'new', specification: encodeSpec },
          { source: 'new', specification: setbackSpec },
        ],
      }),
      newTasks: [makeIssuedTask('task-hand-1', 'kp-resilient', at.planned)],
      now: at.planned,
    });
    expect(extra).toEqual({ ok: false, reason: 'invalid_decision' });

    expectUnchanged(repository, state);
  });

  test('F2 任务与规格不符时不保存', async () => {
    const { repository } = setup();
    const state = repository.load().state;
    const task = makeIssuedTask('task-hand-1', 'kp-resilient', at.planned);
    const tampered = {
      ...task,
      content: { ...task.content, wordId: 'kp-ubiquitous' },
    } as Model.LearningTask;
    const result = await applyHandCrafted(repository, {
      planId: 'plan-hand',
      decision: baseDecision(),
      newTasks: [tampered],
      now: at.planned,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_decision' });
    expectUnchanged(repository, state);
  });

  test('F3 新任务 ID 与库中已有任务重复时不保存', async () => {
    const { repository } = setup((base) => {
      base.tasks.push(makeIssuedTask('task-hand-1', 'kp-deliberate', '2026-11-12T01:00:00.000Z'));
    });
    const state = repository.load().state;
    const result = await applyHandCrafted(repository, {
      planId: 'plan-hand',
      decision: baseDecision(),
      newTasks: [makeIssuedTask('task-hand-1', 'kp-resilient', at.planned)],
      now: at.planned,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_decision' });
    expectUnchanged(repository, state);
  });

  test('F4 existing 位置引用非 issued 任务时不保存', async () => {
    const { repository } = setup((base) => {
      base.tasks.push(makeCompletedTask('task-done', 'kp-deliberate', '2026-11-12T01:00:00.000Z', at.answered));
    });
    const state = repository.load().state;
    const result = await applyHandCrafted(repository, {
      planId: 'plan-hand',
      decision: baseDecision({ tasks: [{ source: 'existing', taskId: 'task-done' }] }),
      newTasks: [],
      now: at.planned,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_decision' });
    expectUnchanged(repository, state);
  });

  test('F5 非法决策：保留任务同时过期与取消、任务总数超容量', async () => {
    const { repository } = setup();
    const state = repository.load().state;
    const overlap = await applyHandCrafted(repository, {
      planId: 'plan-hand',
      decision: baseDecision({ expireTaskIds: ['task-x'], cancelTaskIds: ['task-x'] }),
      newTasks: [makeIssuedTask('task-hand-1', 'kp-resilient', at.planned)],
      now: at.planned,
    });
    expect(overlap).toEqual({ ok: false, reason: 'invalid_decision' });

    const setbackSpec: TaskSpecification = { goalId, wordId: 'kp-setback', task: 'ENCODE' };
    const overCapacity = await applyHandCrafted(repository, {
      planId: 'plan-hand',
      decision: baseDecision({
        taskCapacity: 1,
        tasks: [
          { source: 'new', specification: encodeSpec },
          { source: 'new', specification: setbackSpec },
        ],
      }),
      newTasks: [
        makeIssuedTask('task-hand-1', 'kp-resilient', at.planned),
        makeIssuedTask('task-hand-2', 'kp-setback', at.planned),
      ],
      now: at.planned,
    });
    expect(overCapacity).toEqual({ ok: false, reason: 'invalid_decision' });

    expectUnchanged(repository, state);
  });

  test('F6 保存窗口内状态被并发修改时返回冲突，不保存本次计划', async () => {
    const { repository } = setup();
    repository.beforeSave = () => repository.injectConcurrentWrite();
    const result = await applyHandCrafted(repository, {
      planId: 'plan-hand',
      decision: baseDecision(),
      newTasks: [makeIssuedTask('task-hand-1', 'kp-resilient', at.planned)],
      now: at.planned,
    });

    expect(result).toEqual({ ok: false, reason: 'concurrency_conflict' });
    expect(repository.saveAttempts).toBe(1);
    const after = repository.load().state;
    expect(after.studyPlans).toHaveLength(0);
    expect(after.tasks).toHaveLength(0);
  });

  test('F7 失败原因写入日志：校验失败记 error，并发冲突记 warn', async () => {
    const invalidEntries: LogEntry[] = [];
    const { repository: invalidRepo } = setup();
    await applyDailyPlanUseCase(
      { repository: invalidRepo, logger: captureLogger(invalidEntries) },
      {
        planId: 'plan-hand',
        decision: baseDecision(),
        newTasks: [],
        now: at.planned,
      },
    );
    expect(invalidEntries).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: '应用每日计划：决策校验失败',
      learnerId,
      date: planDate,
    }));

    const conflictEntries: LogEntry[] = [];
    const { repository: conflictRepo } = setup();
    conflictRepo.beforeSave = () => conflictRepo.injectConcurrentWrite();
    await applyDailyPlanUseCase(
      { repository: conflictRepo, logger: captureLogger(conflictEntries) },
      {
        planId: 'plan-hand',
        decision: baseDecision(),
        newTasks: [makeIssuedTask('task-hand-1', 'kp-resilient', at.planned)],
        now: at.planned,
      },
    );
    expect(conflictEntries).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: '应用每日计划：状态已被并发修改，请从排期决策重新执行',
      learnerId,
      date: planDate,
    }));
  });

  test('成功时 info 日志包含计划标识与任务数', async () => {
    const entries: LogEntry[] = [];
    const { repository, provider } = setup();
    const { decision, newTasks } = await planAndGenerate(repository, provider, planDate, at.planned);
    await applyDailyPlanUseCase(
      { repository, logger: captureLogger(entries) },
      { planId: 'plan-day-1', decision, newTasks, now: at.planned },
    );
    expect(entries).toContainEqual(expect.objectContaining({
      level: 'info',
      msg: '应用每日计划：计划已保存',
      planId: 'plan-day-1',
      taskCount: 5,
    }));
  });
});
