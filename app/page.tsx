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
  const [selectedGoal,setSelectedGoal]=useState<string|null>(null);
  const [allActiveGoals,setAllActiveGoals]=useState(false);
  const feedRef = useRef<HTMLElement>(null);
  const [tasks, setTasks] = useState<Array<LearningTaskView & {sources?:Array<{id:string;title:string}>}> | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [planDate, setPlanDate] = useState<string | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const [results, setResults] = useState<Record<string, AttemptResponse>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [sourcePopup, setSourcePopup] = useState<Array<{id:string;title:string}>|null>(null);
  const [aboutOpen,setAboutOpen]=useState(false);
  const [goals, setGoals] = useState<Array<{id:string;title:string;status:string}>>([]);
  const [goalState,setGoalState]=useState<Record<string,{candidates:number;included:number;ready:number}>>({});
  const [assessmentDone, setAssessmentDone] = useState(false);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2200);
  }, []);

  const loadPlan = useCallback(async () => {
    setPlanLoading(true);
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
    } finally {
      setPlanLoading(false);
    }
  }, []);

  useEffect(() => {
    const goalFromUrl=new URLSearchParams(window.location.search).get('goal');
    setSelectedGoal(goalFromUrl);
    setAllActiveGoals(!goalFromUrl);
    void loadPlan();
    void Promise.all([apiGet<{goals:Array<{id:string;title:string;status:string}>}>('/api/goals'), apiGet<{learner:{currentVocabulary: unknown}}>('/api/learner')]).then(async ([g,l]) => { setGoals(g.goals); setAssessmentDone(Boolean(l.learner.currentVocabulary)); const active=g.goals.filter(x=>x.status==='active'); const states=await Promise.all(active.map(async goal=>{const d=await apiGet<{candidates:Array<{selection:string;learning:unknown}>}>(`/api/goals/${goal.id}`);return [goal.id,{candidates:d.candidates.length,included:d.candidates.filter(c=>c.selection==='included').length,ready:d.candidates.filter(c=>c.selection==='included'&&c.learning).length}] as const;}));setGoalState(Object.fromEntries(states)); }).catch(() => {});
  }, [loadPlan]);

  const activeGoalIds=new Set(goals.filter(goal=>goal.status==='active').map(goal=>goal.id));
  const visibleTasks=tasks?.filter(task=>activeGoalIds.has(task.goalId)&&(allActiveGoals||!selectedGoal||task.goalId===selectedGoal))??[];

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
      if (!['settled','completed'].includes(result.status)) {
        notify(result.statusReason ? `作答未完成：${result.statusReason}` : '作答尚未结算，请重试。');
        return;
      }
      setTasks((current) => {
        if (!current) return current;
        const marked = current.map((item) =>
          item.id === task.id ? { ...item, status: 'completed' as const, completedAt: new Date().toISOString() } : item,
        );
        const known = new Set(marked.map((item) => item.id));
        const merged = (result.refresh.tasks ?? []).map(item=>({...item,sources:item.sources??current.find(old=>old.id===item.id)?.sources??[]}));
        return [...marked, ...merged.filter((item) => !known.has(item.id))];
      });
      const index = visibleTasks.findIndex((item) => item.id === task.id);
      const axis = task.content.task === 'RETRIEVE' || task.content.task === 'FLUENCY' ? task.content.content.axis : null;
      const dimension = axis ? result.judgement?.dimensions?.[axis] : undefined;
      const celebrated = dimension?.outcome === 'correct';
      if (celebrated) {
        setCelebrating(true);
        window.setTimeout(() => setCelebrating(false), 2400);
      }
      if (index >= 0) window.setTimeout(() => goToSlide(index + 1), celebrated ? 2500 : 250);
    } catch (error) {
      notify(error instanceof ApiError ? `提交失败：${error.message}` : '提交失败，请重试。');
    } finally {
      setSubmittingId(null);
    }
  }, [notify, visibleTasks, goToSlide]);
  const slideCount = visibleTasks.length + 1; // 当前视图末尾追加状态卡
  const pendingCount = visibleTasks.filter((task) => task.status !== 'completed').length;
  const firstPendingIndex = visibleTasks.findIndex((task) => task.status !== 'completed');

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setAboutOpen(true)} aria-label="应用介绍">
          flow<span>.</span>
        </button>
        <div className="top-tabs goal-tabs" aria-label="学习目标">
          {goals.filter(g=>g.status==='active').map(g=><button className={selectedGoal===g.id&&!allActiveGoals?'active':''} key={g.id} onClick={()=>{setAllActiveGoals(false);setSelectedGoal(g.id);router.push(`/?goal=${g.id}`)}}>{g.title}</button>)}
          <button className={allActiveGoals?'active':''} onClick={()=>{setAllActiveGoals(true);setSelectedGoal(null);router.push('/')}}>全部目标</button>
        </div>
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
                  <span className="word-kicker">PREPARING</span>
                  <h1>正在准备<br />今日学习…</h1>
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
                  <button className="primary-button" disabled={planLoading} onClick={() => void loadPlan()}>{planLoading ? '正在重试…' : '重试加载'}</button>
                </div>
              </article>
            </div>
          </section>
        )}

        {visibleTasks.map((task, index) => (
          <section className="feed-slide" key={task.id} aria-label={`学习任务 ${index + 1}`}>
            <div className="slide-inner">
              <TaskCard
                task={task}
                index={index}
                active={activeSlide === index}
                result={results[task.id] ?? null}
                submitting={submittingId === task.id}
                onSubmit={(submission, elapsedMs) => void submitAttempt(task, submission, elapsedMs)}
                onNext={() => goToSlide(visibleTasks.length)}
                notify={notify}
              />
              <button className="creator-meta" onClick={()=>setSourcePopup(task.sources??[])}><strong>@{task.sources?.[0]?.title??'来源材料'}</strong><p>{task.sources&&task.sources.length>1?'…':'点击查看来源材料'}</p></button>
            </div>
          </section>
        ))}

        {tasks !== null && !planError && <section className="feed-slide">
          <div className="slide-inner">
            <article className="learning-card status-card">
              <div className="card-body status-body">
                <span className="word-kicker">{pendingCount === 0 && visibleTasks.length > 0 ? 'ALL DONE' : pendingCount > 0 ? 'CONTINUE TODAY' : 'GET READY'}</span>
                {pendingCount === 0 && visibleTasks.length > 0 ? (
                  <>
                    <h1>今日任务<br />已全部完成</h1>
                    <p>结算已生效，明天会有新的复习与学习任务。</p>
                  </>
                ) : pendingCount > 0 ? (
                  <>
                    <h1>今日学习<br />还在继续</h1>
                    <p>还有 {pendingCount} 个任务待处理，回到第一项继续学习。</p>
                  </>
                ) : (
                  <>
                    <h1>今日还没有<br />学习任务</h1>
                    <p>{!assessmentDone ? '先完成词汇测评，Flow 会据此安排适合你的学习内容。' : goals.filter(g=>g.status==='active').length === 0 ? '创建一个学习目标，再加入材料和知识点。' : (()=>{const goal=selectedGoal?goals.find(g=>g.id===selectedGoal&&g.status==='active'):goals.find(g=>g.status==='active');const state=goal?goalState[goal.id]:null;if(!goal)return '创建一个正在学习的目标，开始你的学习计划。';if(!state)return '正在检查目标的学习内容…';if(state.candidates===0)return '为目标补充材料，导入后即可选择学习内容。';if(state.ready===0)return state.included===0?'选择要学习的知识点，开始今日学习。':'先完成词汇测评，再初始化知识点学习状态。';return '当前目标暂时没有到期任务，可以查看目标学习进度。';})()}</p>
                  </>
                )}
                <div className="status-actions">
                  {pendingCount > 0 && <button className="text-button" onClick={() => goToSlide(firstPendingIndex)}>继续学习</button>}
                  {pendingCount === 0 && !assessmentDone && <button className="text-button" onClick={() => router.push('/setup')}>开始词汇测评</button>}
                  {pendingCount === 0 && assessmentDone && (selectedGoal && goalState[selectedGoal]?.ready ? <button className="text-button" onClick={()=>router.push(`/?goal=${selectedGoal}`)}>开始学习</button> : <button className="text-button" onClick={() => selectedGoal ? router.push(`/goals/${selectedGoal}`) : router.push('/goals')}>{goals.some(g=>g.status==='active') ? '目标与材料' : '创建目标'}</button>)}
                </div>
              </div>
            </article>
          </div>
        </section>}
      </main>

      <div className="video-progress" aria-hidden="true">
        <i style={{ width: `${((activeSlide + 1) / slideCount) * 100}%` }} />
      </div>

      {celebrating && <div className="correct-celebration" role="status" aria-live="assertive"><span aria-hidden="true">🎉</span><strong>答对了！</strong><span className="celebration-confetti" aria-hidden="true">✦　✨　🎊　✦　✨</span></div>}

      <nav className="bottom-nav" aria-label="主导航">
        <button className="nav-item active">首页</button>
        <button className="nav-item" onClick={() => router.push('/knowledge')}>知识点库</button>
        <button className="nav-item" onClick={() => router.push('/goals')}>目标</button>
        <button className="nav-item" onClick={() => router.push('/me')}>我</button>
      </nav>

      <div className={`toast ${toast ? 'visible' : ''}`} role="status">{toast}</div>
      {aboutOpen&&<div className="modal-backdrop" role="presentation" onClick={()=>setAboutOpen(false)}><section className="doc-card source-popup" role="dialog" aria-modal="true" aria-label="关于 Flow" onClick={event=>event.stopPropagation()}><h2>关于 Flow</h2><p>通过词汇测评了解起点，围绕学习目标导入材料并选择知识点，再以每日练习逐步提升理解与表达能力。</p><p className="doc-muted">笔记与评论：TODO（后续迭代）</p><button className="primary-button" onClick={()=>setAboutOpen(false)}>关闭</button></section></div>}
      {sourcePopup&&<div className="modal-backdrop" role="presentation" onClick={()=>setSourcePopup(null)}><section className="doc-card source-popup" role="dialog" aria-modal="true" aria-label="来源材料" onClick={event=>event.stopPropagation()}><h2>来源材料</h2><ul className="doc-list">{sourcePopup.map(source=><li key={source.id}>{source.title}</li>)}</ul><button className="primary-button" onClick={()=>setSourcePopup(null)}>关闭</button></section></div>}
    </div>
  );
}
