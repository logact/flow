'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import type {
  AttemptResponse,
  LearningTaskView,
  PlanFailureResponse,
  TaskSubmission,
  TodayPlanResponse,
} from '@/lib/client/types';
import { TaskCard } from '@/components/learning/TaskCard';

const PLAN_REASON_TEXT: Record<string, string> = {
  learner_not_found: '学习者不存在，请刷新重试。',
  task_generation_failed: '任务生成失败：请检查 LLM_API_KEY 配置与 AI 服务可用性后重试。',
  invalid_decision: '排期决策校验失败，请刷新重试。',
  concurrency_conflict: '状态被并发修改，请刷新重试。',
};

export default function LearningFeedPage() {
  const router = useRouter();
  const feedRef = useRef<HTMLElement>(null);
  const [tasks, setTasks] = useState<LearningTaskView[] | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planDate, setPlanDate] = useState<string | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const [results, setResults] = useState<Record<string, AttemptResponse>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2200);
  }, []);

  const loadPlan = useCallback(async () => {
    setTasks(null);
    setPlanError(null);
    try {
      const data = await apiGet<TodayPlanResponse>('/api/plan/today');
      setTasks(data.tasks);
      setPlanDate(data.date);
    } catch (error) {
      const reason = error instanceof ApiError ? error.reason : null;
      setPlanError(
        (reason && PLAN_REASON_TEXT[reason])
        ?? (error instanceof ApiError ? error.message : '计划加载失败，请重试。'),
      );
    }
  }, []);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const goToSlide = useCallback((index: number) => {
    const feed = feedRef.current;
    if (!feed) return;
    const next = Math.max(0, index);
    feed.scrollTo({ top: next * feed.clientHeight, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.key === 'ArrowDown' || event.key === 'PageDown') {
        event.preventDefault();
        goToSlide(activeSlide + 1);
      }
      if (event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault();
        goToSlide(activeSlide - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSlide, goToSlide]);

  const submitAttempt = useCallback(async (task: LearningTaskView, submission: TaskSubmission, elapsedMs: number) => {
    setSubmittingId(task.id);
    try {
      const result = await apiPost<AttemptResponse>(`/api/tasks/${task.id}/attempt`, {
        submission,
        validity: { elapsedMs: Math.max(1, Math.round(elapsedMs)), interrupted: false },
      });
      setResults((value) => ({ ...value, [task.id]: result }));
      setTasks((current) => {
        if (!current) return current;
        const marked = current.map((item) =>
          item.id === task.id ? { ...item, status: 'completed' as const, completedAt: new Date().toISOString() } : item,
        );
        const known = new Set(marked.map((item) => item.id));
        const merged = result.refresh.tasks ?? [];
        return [...marked, ...merged.filter((item) => !known.has(item.id))];
      });
    } catch (error) {
      notify(error instanceof ApiError ? `提交失败：${error.message}` : '提交失败，请重试。');
    } finally {
      setSubmittingId(null);
    }
  }, [notify]);

  const slideCount = (tasks?.length ?? 0) + 1; // 末尾追加一张完成/引导卡
  const pendingCount = tasks?.filter((task) => task.status !== 'completed').length ?? 0;

  const actionRail = (index: number) => (
    <aside className="action-rail" aria-label="学习卡操作">
      <button className="creator-avatar" onClick={() => notify('Flow 每日英语 · 学习创作者主页')} aria-label="查看创作者主页">
        <span>F</span>
      </button>
      <button className="rail-action" onClick={() => notify('学习笔记与讨论为原型占位')} aria-label="查看学习笔记">
        <span className="rail-icon rail-icon-text">论</span>
      </button>
      <button className="rail-action" onClick={() => notify('收藏学习卡为原型占位')} aria-label="收藏">
        <span className="rail-icon rail-icon-text">藏</span>
      </button>
      <button className="rail-action" onClick={() => notify('分享学习卡为原型占位')} aria-label="分享">
        <span className="rail-icon rail-icon-text">享</span>
      </button>
    </aside>
  );

  const creatorMeta = (caption: string) => (
    <div className="creator-meta">
      <strong>@Flow每日英语</strong>
      <p>{caption}</p>
      <div><span>今日计划 · {planDate ?? '—'}</span></div>
    </div>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => { setActiveSlide(0); goToSlide(0); void loadPlan(); }} aria-label="刷新今日计划">
          flow<span>.</span>
        </button>
        <div className="top-tabs" aria-label="学习模式">
          <button onClick={() => notify('关注页面为原型占位')}>关注</button>
          <button className="active">学习</button>
          <button onClick={() => notify(pendingCount > 0 ? `今日还有 ${pendingCount} 个任务` : '今日任务已全部完成')}>
            复习{pendingCount > 0 && <span className="review-badge visible">{pendingCount}</span>}
          </button>
        </div>
        <button className="search-button" onClick={() => router.push('/materials')} aria-label="材料与词库">词库</button>
      </header>

      <main
        className="learning-feed"
        ref={feedRef}
        onScroll={(event) => {
          const feed = event.currentTarget;
          setActiveSlide(Math.max(0, Math.min(slideCount - 1, Math.round(feed.scrollTop / feed.clientHeight))));
        }}
      >
        {tasks === null && !planError && (
          <section className="feed-slide">
            <div className="slide-inner">
              <article className="learning-card status-card">
                <div className="card-body status-body">
                  <span className="word-kicker">TODAY'S PLAN</span>
                  <h1>正在生成<br />今日计划…</h1>
                  <p>排期与出题需要几秒钟，请稍候。</p>
                </div>
              </article>
            </div>
          </section>
        )}

        {planError && (
          <section className="feed-slide">
            <div className="slide-inner">
              <article className="learning-card status-card">
                <div className="card-body status-body">
                  <span className="word-kicker">PLAN UNAVAILABLE</span>
                  <h1>计划加载失败</h1>
                  <p>{planError}</p>
                  <button className="primary-button" onClick={() => void loadPlan()}>重试</button>
                </div>
              </article>
            </div>
          </section>
        )}

        {tasks?.map((task, index) => (
          <section className="feed-slide" key={task.id} aria-label={`学习任务 ${index + 1}`}>
            <div className="slide-inner">
              <TaskCard
                task={task}
                index={index}
                active={activeSlide === index}
                result={results[task.id] ?? null}
                submitting={submittingId === task.id}
                onSubmit={(submission, elapsedMs) => void submitAttempt(task, submission, elapsedMs)}
                onNext={() => goToSlide(index + 1)}
                notify={notify}
              />
              {actionRail(index)}
              {creatorMeta('把今天的词，用进你自己的故事里')}
            </div>
          </section>
        ))}

        <section className="feed-slide">
          <div className="slide-inner">
            <article className="learning-card status-card">
              <div className="card-body status-body">
                <span className="word-kicker">{pendingCount === 0 && (tasks?.length ?? 0) > 0 ? 'ALL DONE' : 'GET READY'}</span>
                {pendingCount === 0 && (tasks?.length ?? 0) > 0 ? (
                  <>
                    <h1>今日任务<br />已全部完成</h1>
                    <p>结算已生效，明天会有新的复习与学习任务。</p>
                  </>
                ) : (
                  <>
                    <h1>今日还没有<br />学习任务</h1>
                    <p>按以下顺序准备：完成词汇测评 → 导入材料并创建目标 → 选择要学的知识点。</p>
                  </>
                )}
                <div className="status-actions">
                  <button className="primary-button" onClick={() => void loadPlan()}>刷新计划</button>
                  <button className="text-button" onClick={() => router.push('/setup')}>词汇测评</button>
                  <button className="text-button" onClick={() => router.push('/goals')}>目标与知识点</button>
                </div>
              </div>
            </article>
          </div>
        </section>
      </main>

      <div className="video-progress" aria-hidden="true">
        <i style={{ width: `${((activeSlide + 1) / slideCount) * 100}%` }} />
      </div>

      <nav className="bottom-nav" aria-label="主导航">
        <button className="nav-item active">首页</button>
        <button className="nav-item" onClick={() => router.push('/materials')}>词库</button>
        <button className="create-button" onClick={() => router.push('/materials')} aria-label="导入学习材料"><span>＋</span></button>
        <button className="nav-item" onClick={() => router.push('/goals')}>目标</button>
        <button className="nav-item" onClick={() => router.push('/me')}>我</button>
      </nav>

      <div className={`toast ${toast ? 'visible' : ''}`} role="status">{toast}</div>
    </div>
  );
}
