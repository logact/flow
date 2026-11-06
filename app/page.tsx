'use client';

import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';
import type { EmptyTaskInstance, ScheduledTaskInstance, TaskEvidence, TaskInstance } from '@/lib/tasks';
import { TaskRenderer, type TaskSubmission } from '@/components/task-renderers';
import styles from './page.module.css';

type WordSnapshot = {
  id: number;
  chunk: string;
  meaning: string;
  scene: string;
  fluency: number;
  fluency_r: number;
};

type Snapshot = {
  tick: number;
  words: WordSnapshot[];
  events: { id: number; tick: number; kind: string; result: string | null }[];
  activeGoalId: number | null;
  goalScopeStrict: boolean;
  goalFluency: number | null;
  goalFluencyR: number | null;
  goalFluencyP: number | null;
  goalAttainment: number | null;
  vocabEstimate: number | null;
  userLevel: { estimate: number; label: string } | null;
  cursorWritingWpm: number;
  cursorReadingWpm: number;
};

type ApiTask = Snapshot & { task: ScheduledTaskInstance; error?: string };
type GoalOption = { id: number; title: string };
type FlowStatus = 'loading' | 'ready' | 'submitting' | 'feedback' | 'error';
type Submission = {
  response: Record<string, unknown>;
  evidence: TaskEvidence;
};

const taskNames: Record<TaskInstance['type'], string> = {
  ENCODE: '建立联系',
  RETRIEVE: '准确提取',
  FLUENCY: '流利训练',
  INTEGRATE: '综合运用',
};

const purposeNames: Record<TaskInstance['purpose'], string> = {
  introduce: '首次学习',
  diagnose: '诊断',
  verify: '验证',
  review: '复习',
  recover: '急救验证',
  relearn: '重学',
  maintain: '维护',
};

const axisNames = { r: '阅读 R', p: '产出 P' } as const;

function isTask(task: ScheduledTaskInstance | null | undefined): task is TaskInstance {
  return task != null && task.type !== 'EMPTY';
}

function isEmpty(task: ScheduledTaskInstance | null | undefined): task is EmptyTaskInstance {
  return task?.type === 'EMPTY';
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

export default function Home() {
  const [data, setData] = useState<ApiTask | null>(null);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [status, setStatus] = useState<FlowStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [nextTask, setNextTask] = useState<ScheduledTaskInstance | null>(null);
  const [writeback, setWriteback] = useState<{ passed: boolean; qualified: boolean; checkpoint: number | null } | null>(null);
  const requestLock = useRef(false);
  const touchStart = useRef<{ y: number; allowed: boolean } | null>(null);

  const load = useCallback(async () => {
    setStatus((previous) => previous === 'loading' ? 'loading' : previous);
    try {
      const next = await readJson<ApiTask>(await fetch('/api/task', { cache: 'no-store' }));
      setData(next);
      setNextTask(null);
      setWriteback(null);
      setErrorMessage('');
      setStatus('ready');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '加载任务失败');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
    void fetch('/api/goals', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body) => setGoals(Array.isArray(body.goals) ? body.goals : []))
      .catch(() => setGoals([]));
  }, [load]);

  useEffect(() => {
    const current = data?.task;
    if (!isEmpty(current) || current.reason !== 'waiting_cooldown') return;
    if (current.next_available_at == null) return;
    const wait = Math.max(0, current.next_available_at - Date.now());
    const timer = window.setTimeout(() => void load(), wait + 30);
    return () => window.clearTimeout(timer);
  }, [data, load]);

  useEffect(() => {
    const current = data?.task;
    if (!isTask(current) || (status !== 'ready' && status !== 'error')) return;
    const instanceId = current.instance_id;
    const reportExit = () => {
      const body = JSON.stringify({ event_type: 'task_exit', instance_id: instanceId });
      const blob = new Blob([body], { type: 'application/json' });
      if (!navigator.sendBeacon('/api/task/analytics', blob)) {
        void fetch('/api/task/analytics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        });
      }
    };
    window.addEventListener('pagehide', reportExit);
    return () => window.removeEventListener('pagehide', reportExit);
  }, [data?.task, status]);

  const setActiveGoal = useCallback(async (goalId: number | null, strict?: boolean) => {
    try {
      await fetch('/api/goals/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId, strict }),
      });
      await load();
    } catch {
      setErrorMessage('更新目标失败，请重试。');
      setStatus('error');
    }
  }, [load]);

  const submit = useCallback(async (instance: TaskInstance, submission: Submission) => {
    if (requestLock.current) return;
    requestLock.current = true;
    setStatus('submitting');
    setErrorMessage('');
    try {
      const response = await fetch('/api/task/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instance_id: instance.instance_id,
          response: submission.response,
          evidence: submission.evidence,
        }),
      });
      const result = await readJson<ApiTask & {
        task: ScheduledTaskInstance;
        writeback: { passed: boolean; qualified: boolean; checkpoint: number | null };
      }>(response);
      setData((current) => current ? { ...current, ...result } : result);
      setNextTask(result.task);
      setWriteback(result.writeback ?? null);
      setStatus('feedback');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '提交失败，请重试。');
      setStatus('error');
      throw error;
    } finally {
      requestLock.current = false;
    }
  }, []);

  const continueToNext = useCallback(() => {
    if (status !== 'feedback' || !nextTask || requestLock.current) return;
    if (data) setData({ ...data, task: nextTask });
    setNextTask(null);
    setWriteback(null);
    setErrorMessage('');
    setStatus('ready');
  }, [data, nextTask, status]);

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    const target = event.target;
    const element = target instanceof Element ? target : null;
    const blocked = element?.closest('input, textarea, select, button, [contenteditable="true"], .taskMaterial') != null;
    touchStart.current = { y: event.touches[0]?.clientY ?? 0, allowed: !blocked };
  };

  const onTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start?.allowed || requestLock.current || status !== 'feedback') return;
    const endY = event.changedTouches[0]?.clientY ?? start.y;
    if (start.y - endY > 80) continueToNext();
  };

  if (status === 'loading' && !data) {
    return <main className={styles.page}><div className={styles.loading}>正在恢复当前任务…</div></main>;
  }
  if (status === 'error' && !data) {
    return (
      <main className={styles.page}>
        <article className={styles.emptyCard}>
          <h1>暂时无法加载任务</h1>
          <p className={styles.muted}>{errorMessage}</p>
          <button className={styles.secondaryButton} onClick={() => void load()}>重试</button>
        </article>
      </main>
    );
  }

  const task: ScheduledTaskInstance | null = data?.task ?? null;
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/">Flow<span>·</span></a>
        <div className={styles.headerMeta}>
          <span className={styles.progress}>已完成 {data?.tick ?? 0} 项</span>
          {data?.goalFluency != null && <span className={styles.goalProgress}>目标进度 {Math.round((data.goalAttainment ?? 0) * 100)}%</span>}
        </div>
        <nav className={styles.headerActions} aria-label="学习设置">
          <select
            aria-label="当前目标"
            value={data?.activeGoalId ?? ''}
            disabled={status === 'submitting'}
            onChange={(event) => void setActiveGoal(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">全部目标</option>
            {goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
          </select>
          <a href="/goals">目标</a>
        </nav>
      </header>

      {data?.activeGoalId != null && (
        <label className={styles.scopeToggle}>
          <input
            type="checkbox"
            checked={data.goalScopeStrict}
            disabled={status === 'submitting'}
            onChange={(event) => void setActiveGoal(data.activeGoalId, event.target.checked)}
          />
          只学当前目标
        </label>
      )}

      <section
        className={styles.flowViewport}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {isEmpty(task) ? (
          <EmptyCard task={task} onRefresh={() => void load()} />
        ) : isTask(task) ? (
          <TaskCard
            key={task.instance_id}
            task={task}
            status={status}
            errorMessage={errorMessage}
            writeback={writeback}
            onSubmit={(submission) => submit(task, submission)}
            onContinue={continueToNext}
          />
        ) : (
          <div className={styles.taskCard}><p>正在加载任务…</p></div>
        )}
      </section>

      <details className={styles.debugDetails}>
        <summary>学习数据与事件（调试）</summary>
        <div className={styles.debugBody}>
          <p>R {data?.goalFluencyR ?? '—'} · P {data?.goalFluencyP ?? '—'} · 词汇量 {data?.vocabEstimate ?? '—'} · 阅读游标 {data?.cursorReadingWpm ?? '—'} wpm · 写作游标 {data?.cursorWritingWpm ?? '—'} wpm</p>
          <pre>{JSON.stringify(data?.events ?? [], null, 2)}</pre>
        </div>
      </details>
    </main>
  );
}

function TaskCard({
  task,
  status,
  errorMessage,
  writeback,
  onSubmit,
  onContinue,
}: {
  task: TaskInstance;
  status: FlowStatus;
  errorMessage: string;
  writeback: { passed: boolean; qualified: boolean; checkpoint: number | null } | null;
  onSubmit: (submission: Submission) => Promise<void>;
  onContinue: () => void;
}) {
  return (
    <>
      {status === 'feedback' ? (
        <article className={styles.taskCard} role="status" aria-live="polite">
          <div className={styles.feedback}>
            <div className={styles.feedbackIcon}>{writeback?.passed ? '✓' : '↗'}</div>
            <div>
              <h2>{task.type === 'ENCODE' ? '教学已记录' : writeback?.passed ? '任务完成' : '已记录本次结果'}</h2>
              <p>{writeback?.qualified ? `已通过 ${writeback.checkpoint} 分关卡。` : '服务端已保存这次作答；成绩只按合格证据更新。'}</p>
              <button className={styles.primaryButton} onClick={onContinue}>继续 <span aria-hidden="true">→</span></button>
              <p className={styles.swipeHint}>也可以在卡片空白处上滑继续</p>
            </div>
          </div>
        </article>
      ) : (
        <div className={styles.taskCard} aria-busy={status === 'submitting'}>
          <div className={styles.taskTopline}>
            <div className={styles.taskTags}>
              <span className={styles.axisTag}>{axisNames[task.axis]}</span>
              <span>{taskNames[task.type]}</span>
              <span>{purposeNames[task.purpose]}</span>
            </div>
            <span className={styles.checkpoint}>{task.checkpoint == null ? '教学' : `${task.checkpoint} 分关卡`}</span>
          </div>
          <div className={styles.renderer}>
            <TaskRenderer
              task={task}
              onSubmit={(submission: TaskSubmission) => onSubmit({
                response: submission.response as Record<string, unknown>,
                evidence: submission.evidence,
              })}
            />
          </div>
          {status === 'error' && <p className={styles.error} role="alert">{errorMessage || '提交失败，当前作答已保留。请重试。'}</p>}
        </div>
      )}
    </>
  );
}

function EmptyCard({ task, onRefresh }: { task: EmptyTaskInstance; onRefresh: () => void }) {
  const content = task.reason === 'waiting_cooldown'
    ? ['暂时没有到复习时间的任务。', '冷却结束后会自动检查新任务，也可以手动刷新。']
    : task.reason === 'materials_unavailable'
      ? ['暂时缺少符合条件的学习材料。', `需要补充：${task.unavailable_materials?.join('、') || '可用材料'}`]
      : ['当前目标下的任务已完成。', '导入新词或调整学习目标后，可以继续学习。'];
  return (
    <article className={styles.emptyCard}>
      <span className={styles.emptyMark}>✓</span>
      <h1>{task.reason === 'waiting_cooldown' ? '休息一下' : task.reason === 'materials_unavailable' ? '等待材料' : '本轮完成'}</h1>
      <p>{content[0]}</p>
      <p className={styles.muted}>{content[1]}</p>
      {task.next_available_at != null && <p className={styles.countdown}>下次可练习 {new Date(task.next_available_at).toLocaleTimeString()}</p>}
      <button className={styles.secondaryButton} onClick={onRefresh}>刷新任务</button>
    </article>
  );
}
