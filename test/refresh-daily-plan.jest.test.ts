/// <reference types="jest" />

import { refreshDailyPlanUseCase } from '../lib/application/refresh-daily-plan';
import type { RefreshDailyPlanResult } from '../lib/application/refresh-daily-plan';
import {
  at,
  planDate,
  RecordingStateRepository,
  setup,
  silentLogger,
} from './helpers/apply-daily-plan-fixture';
import { FakeTaskAIProvider, InMemoryTaskRepository, learnerId } from './helpers/task-generation-fixture';

function taskIdSequence(prefix = 'task'): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function refresh(
  repository: RecordingStateRepository,
  provider: FakeTaskAIProvider,
  newTaskId: () => string,
  maxAttempts?: number,
): Promise<RefreshDailyPlanResult> {
  return refreshDailyPlanUseCase(
    {
      repository,
      taskRepository: new InMemoryTaskRepository(repository.load().state),
      aiProvider: provider,
      newTaskId,
      maxAttempts,
      logger: silentLogger,
    },
    { learnerId, date: planDate, now: at.planned },
  );
}

describe('R1：刷新每日计划（S07～S09 编排）', () => {
  test('成功：重新决策、批量生成并一次性保存计划与任务', async () => {
    const { repository, provider } = setup();
    const result = await refresh(repository, provider, taskIdSequence());

    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.plan.learnerId).toBe(learnerId);
    expect(result.plan.date).toBe(planDate);
    expect(result.plan.taskIds).toHaveLength(5);
    expect(provider.requests).toHaveLength(5);
    // 按决策顺序排列的公开任务视图，ID 与计划一致。
    expect(result.tasks.map((task) => task.id)).toEqual(result.plan.taskIds);

    const saved = repository.load();
    expect(saved.revision).toBe(1);
    for (const taskId of result.plan.taskIds) {
      const task = saved.state.tasks.find((item) => item.id === taskId);
      expect(task?.status).toBe('issued');
    }
  });

  test('new 为空时不调用 AI，取消等状态变化照常落库', async () => {
    const { inner, repository, provider } = setup();
    const first = await refresh(repository, provider, taskIdSequence('first'));
    if (!first.ok) throw new Error(`expected ok, got ${first.reason}`);
    expect(provider.requests).toHaveLength(5);

    //  learners 容量更新不直接重写历史计划，下一次刷新时才应用并取消溢出任务。
    const snapshot = inner.load();
    inner.save({
      ...snapshot.state,
      learners: snapshot.state.learners.map((item) => ({ ...item, dailyTaskCapacity: 0 })),
    }, snapshot.revision);
    provider.requests.length = 0;

    const second = await refresh(repository, provider, taskIdSequence('second'));
    if (!second.ok) throw new Error(`expected ok, got ${second.reason}`);
    expect(provider.requests).toHaveLength(0);
    expect(second.plan.taskIds).toEqual([]);
    const saved = repository.load().state;
    expect(saved.studyPlans.find((plan) => plan.date === planDate)?.taskIds).toEqual([]);
    expect(saved.tasks.every((task) => task.status === 'cancelled')).toBe(true);
  });

  test('任一生成失败时整体返回失败，不落任何状态', async () => {
    const { repository, inner } = setup();
    const failing = new FakeTaskAIProvider(() => {
      throw new Error('供应商不可用');
    });
    const result = await refresh(repository, failing, taskIdSequence());

    expect(result).toEqual({ ok: false, reason: 'task_generation_failed' });
    expect(failing.requests.length).toBeGreaterThan(0);
    const snapshot = inner.load();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.state.studyPlans).toEqual([]);
    expect(snapshot.state.tasks).toEqual([]);
  });

  test('S09 保存时检测到并发冲突则从第 1 步重新执行并成功', async () => {
    const { repository, provider } = setup();
    repository.beforeSave = () => {
      repository.injectConcurrentWrite();
      repository.beforeSave = null;
    };

    const result = await refresh(repository, provider, taskIdSequence());
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    // 第一轮 5 次生成 + 重试后重新决策再生成 5 次。
    expect(provider.requests).toHaveLength(10);
    expect(repository.saveAttempts).toBe(2);
    expect(repository.load().revision).toBe(2);
    expect(result.plan.taskIds).toHaveLength(5);
  });

  test('并发冲突重试有上限，用尽后返回冲突失败', async () => {
    const { repository, provider } = setup();
    repository.beforeSave = () => repository.injectConcurrentWrite();

    const result = await refresh(repository, provider, taskIdSequence(), 3);
    expect(result).toEqual({ ok: false, reason: 'concurrency_conflict' });
    expect(repository.saveAttempts).toBe(3);
    expect(repository.load().revision).toBe(3);
  });

  test('学习者不存在时返回 learner_not_found', async () => {
    const { repository, provider } = setup();
    const result = await refreshDailyPlanUseCase(
      {
        repository,
        taskRepository: new InMemoryTaskRepository(repository.load().state),
        aiProvider: provider,
        newTaskId: taskIdSequence(),
      },
      { learnerId: 'learner-missing', date: planDate, now: at.planned },
    );
    expect(result).toEqual({ ok: false, reason: 'learner_not_found' });
    expect(provider.requests).toHaveLength(0);
  });

  test('同一 (learnerId, date) 重复调用安全：第二次保留既有任务且不再调用 AI', async () => {
    const { repository, provider } = setup();
    const first = await refresh(repository, provider, taskIdSequence());
    if (!first.ok) throw new Error(`expected ok, got ${first.reason}`);

    const second = await refresh(repository, provider, taskIdSequence());
    if (!second.ok) throw new Error(`expected ok, got ${second.reason}`);
    expect(second.plan.taskIds).toEqual(first.plan.taskIds);
    expect(provider.requests).toHaveLength(5);
    expect(repository.load().revision).toBe(2);
  });
});
