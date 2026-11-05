'use client';

import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';
import type { EmptyTaskInstance, ScheduledTaskInstance, TaskEvidence, TaskInstance } from '@/lib/tasks';
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

function isTask(task: ScheduledTaskInstance | null): task is TaskInstance {
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
  const activeWords = isTask(task)
    ? task.word_ids.map((id) => data?.words.find((word) => word.id === id)).filter((word): word is WordSnapshot => word != null)
    : [];

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
            words={activeWords}
            status={status}
            errorMessage={errorMessage}
            writeback={writeback}
            onSubmit={(submission) => void submit(task, submission)}
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
  words,
  status,
  errorMessage,
  writeback,
  onSubmit,
  onContinue,
}: {
  task: TaskInstance;
  words: WordSnapshot[];
  status: FlowStatus;
  errorMessage: string;
  writeback: { passed: boolean; qualified: boolean; checkpoint: number | null } | null;
  onSubmit: (submission: Submission) => void;
  onContinue: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const [passageAnswer, setPassageAnswer] = useState<number | null>(null);
  const readingStarted = useRef<number | null>(null);
  const writeStarted = useRef<number | null>(null);
  const payload = task.payload;
  const evidenceDefinition = payload.evidence as { accuracy_check?: string[]; speed_mode?: TaskEvidence['speed_mode'] } | undefined;
  const accuracyChecks = evidenceDefinition?.accuracy_check ?? [];
  const speedMode = evidenceDefinition?.speed_mode ?? 'none';
  const isReading = task.axis === 'r' && (task.type === 'FLUENCY' || task.type === 'INTEGRATE');
  const isWriting = task.axis === 'p' && (task.type === 'FLUENCY' || task.type === 'INTEGRATE');
  const text = typeof payload.continuous_text === 'string' ? payload.continuous_text : '';
  const options = Array.isArray(payload.options) ? payload.options.filter((option): option is string => typeof option === 'string') : [];
  const submitting = status === 'submitting';
  const editable = status === 'ready' || status === 'error';
  const isEncode = task.type === 'ENCODE';
  const mainWord = words[0];
  const startReading = () => {
    if (readingStarted.current == null) readingStarted.current = Date.now();
  };

  useEffect(() => {
    if (isReading && readingStarted.current == null) readingStarted.current = Date.now();
  }, [isReading, task.instance_id]);

  const send = () => {
    const duration = isReading
      ? Math.max(1, Date.now() - (readingStarted.current ?? Date.now()))
      : isWriting
        ? Math.max(1, Date.now() - (writeStarted.current ?? Date.now()))
        : null;
    const response: Record<string, unknown> = isWriting
      ? { text: answer }
      : { answer };
    if (passageAnswer != null) response.passage_answer_index = passageAnswer;
    const accuracy: Record<string, boolean> = {};
    for (const key of accuracyChecks) accuracy[key] = false;
    const submission: Submission = {
      response,
      evidence: {
        independent: !isEncode,
        answer_revealed: false,
        hint_used: false,
        accuracy,
        speed_mode: speedMode,
        speed_value: null,
        duration_ms: duration,
        word_results: task.word_ids.map((word_id) => ({ word_id, correct: false })),
      },
    };
    onSubmit(submission);
  };

  const label = taskNames[task.type];
  const wordsForPrompt = words.map((word) => task.axis === 'r' ? word.chunk : word.meaning);

  return (
    <article className={styles.taskCard} aria-busy={submitting}>
      <div className={styles.taskTopline}>
        <div className={styles.taskTags}>
          <span className={styles.axisTag}>{axisNames[task.axis]}</span>
          <span>{label}</span>
          <span>{purposeNames[task.purpose]}</span>
        </div>
        <span className={styles.checkpoint}>{task.checkpoint == null ? '教学' : `${task.checkpoint} 分关卡`}</span>
      </div>

      {status === 'feedback' ? (
        <div className={styles.feedback} role="status" aria-live="polite">
          <div className={styles.feedbackIcon}>{writeback?.passed ? '✓' : '↗'}</div>
          <div>
            <h2>{task.type === 'ENCODE' ? '教学已记录' : writeback?.passed ? '任务完成' : '已记录本次结果'}</h2>
            <p>{writeback?.qualified ? `已通过 ${writeback.checkpoint} 分关卡。` : '服务端已保存这次作答；成绩只按合格证据更新。'}</p>
            <button className={styles.primaryButton} onClick={onContinue}>继续 <span aria-hidden="true">→</span></button>
            <p className={styles.swipeHint}>也可以在卡片空白处上滑继续</p>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.taskContent}>
            <p className={styles.instruction}>
              {isEncode ? '先查看这个词的形式和用法。教学记录不会增加关卡分。' : task.axis === 'r' ? '独立理解目标表达，答案不会预先展示。' : '根据提示独立写出或使用目标表达。'}
            </p>
            {isEncode ? (
              <>
                <h1 className={styles.targetWord}>{String(payload.chunk ?? mainWord?.chunk ?? '学习词条')}</h1>
                <p className={styles.meaning}>{String(payload.meaning ?? mainWord?.meaning ?? '')}</p>
                <p className={styles.scene}>{String(payload.example_sentence ?? mainWord?.scene ?? '')}</p>
              </>
            ) : isReading ? (
              <>
                <div className={`${styles.material} taskMaterial`} onScroll={startReading}>
                  {text ? <p>{text}</p> : <p className={styles.missing}>这项任务没有可用的连续材料。</p>}
                </div>
                {task.type === 'INTEGRATE' && <p className={styles.targetPrompt}>请在阅读中理解：{wordsForPrompt.join('、')}</p>}
                <label className={styles.fieldLabel} htmlFor={`answer-${task.instance_id}`}>{task.type === 'INTEGRATE' ? '用自己的话解释目标词' : '目标表达在这里是什么意思？'}</label>
                <textarea id={`answer-${task.instance_id}`} rows={3} value={answer} onFocus={startReading} onChange={(event) => { startReading(); setAnswer(event.target.value); }} disabled={!editable} placeholder="用自己的话回答" />
                {options.length > 0 && (
                  <fieldset className={styles.options}>
                    <legend>整段理解</legend>
                    {options.map((option, index) => (
                      <label key={index} className={styles.option}>
                        <input type="radio" name={`passage-${task.instance_id}`} checked={passageAnswer === index} onChange={() => setPassageAnswer(index)} disabled={!editable} />
                        {option}
                      </label>
                    ))}
                  </fieldset>
                )}
              </>
            ) : isWriting ? (
              <>
                <div className={styles.writingPrompt}>
                  <p>{task.type === 'INTEGRATE' ? '请把这些表达自然地写进一段连贯内容：' : '请根据这些意思写一段连贯表达：'}</p>
                  <ul>{wordsForPrompt.map((word, index) => <li key={index}>{word}</li>)}</ul>
                </div>
                <label className={styles.fieldLabel} htmlFor={`answer-${task.instance_id}`}>你的表达</label>
                <textarea
                  id={`answer-${task.instance_id}`}
                  className={styles.longAnswer}
                  rows={8}
                  value={answer}
                  onFocus={() => { writeStarted.current ??= Date.now(); }}
                  onChange={(event) => { writeStarted.current ??= Date.now(); setAnswer(event.target.value); }}
                  disabled={!editable}
                  placeholder="在这里写完整内容…"
                />
              </>
            ) : (
              <>
                {task.axis === 'p' ? (
                  <>
                    <p className={styles.meaning}>{String(payload.meaning ?? mainWord?.meaning ?? '')}</p>
                    {String(payload.example_sentence ?? '') && <p className={styles.scene}>{String(payload.example_sentence)}</p>}
                  </>
                ) : (
                  <>
                    <h1 className={styles.targetWord}>{String(payload.chunk ?? mainWord?.chunk ?? '')}</h1>
                    {String(payload.example_sentence ?? '') && <p className={styles.scene}>{String(payload.example_sentence)}</p>}
                  </>
                )}
                <label className={styles.fieldLabel} htmlFor={`answer-${task.instance_id}`}>
                  {task.axis === 'r' ? '解释这个表达在语境中的意思' : '写出对应的英语表达'}
                </label>
                <input
                  id={`answer-${task.instance_id}`}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && answer.trim() && editable) send();
                  }}
                  disabled={!editable}
                  autoComplete="off"
                />
              </>
            )}
          </div>

          {status === 'error' && <div className={styles.error} role="alert">{errorMessage || '提交失败，当前作答已保留。'} <button type="button" onClick={send}>重试</button></div>}
          <footer className={styles.cardFooter}>
            <span className={styles.statusNote}>{submitting ? '正在提交并保存学习证据…' : '提交后会显示反馈，再进入下一项任务。'}</span>
            <button className={styles.primaryButton} type="button" onClick={send} disabled={!editable || (task.type !== 'ENCODE' && !answer.trim()) || (isReading && options.length > 0 && passageAnswer == null)}>
              {submitting ? '提交中…' : isEncode ? '完成教学' : '提交作答'}
            </button>
          </footer>
        </>
      )}
    </article>
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
