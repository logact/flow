'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import type {
  LearnerResponse,
  StartAssessmentResponse,
  SubmitAssessmentResponse,
} from '@/lib/client/types';
import { PageShell } from '@/components/PageShell';

/** 词汇自评定级（S02/S03）：认识/不认识自评，完成后产出词汇水平估计。 */
export default function SetupPage() {
  const router = useRouter();
  const [learner, setLearner] = useState<LearnerResponse['learner'] | null>(null);
  const [assessment, setAssessment] = useState<StartAssessmentResponse | null>(null);
  const [cursor, setCursor] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitAssessmentResponse['result'] | null>(null);
  const [finishing, setFinishing] = useState(false);
  const attemptRef = useRef<{ taskId: string; attemptId: string } | null>(null);

  useEffect(() => {
    void apiGet<LearnerResponse>('/api/learner').then((data) => setLearner(data.learner)).catch(() => undefined);
    void apiGet<{ assessment: StartAssessmentResponse | null }>('/api/assessments').then(({ assessment: current }) => {
      if (current) { setAssessment(current); setCursor(current.cursor); }
    }).catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const data = await apiPost<StartAssessmentResponse>('/api/assessments');
      setAssessment(data);
      setCursor(data.cursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '测评创建失败，请重试。');
    }
  }, []);

  const answer = useCallback(async (known: boolean) => {
    if (!assessment || submitting) return;
    const task = assessment.tasks[cursor];
    if (!task) return;
    if (attemptRef.current?.taskId !== task.id) attemptRef.current = { taskId: task.id, attemptId: crypto.randomUUID() };
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiPost<SubmitAssessmentResponse>(`/api/assessments/${assessment.assessmentId}/attempts`, {
        taskId: task.id,
        known,
        attemptId: attemptRef.current.attemptId,
      });
      attemptRef.current = null;
      if (data.status === 'completed' && data.result) {
        setResult(data.result);
        setAssessment(null);
      } else {
        if (data.tasks) setAssessment((current) => current ? { ...current, tasks: data.tasks!, cursor: data.cursor ?? cursor + 1, answered: data.answered ?? current.answered + 1, total: data.total ?? data.tasks!.length, currentBand: data.currentBand ?? current.currentBand, bandAnswered: data.bandAnswered ?? 0, bandTotal: data.bandTotal ?? 0 } : current);
        setCursor(data.cursor ?? cursor + 1);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '提交失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  }, [assessment, cursor, submitting]);

  const finishAssessment = useCallback(async () => {
    if (!assessment || finishing) return;
    setFinishing(true);
    setError(null);
    try {
      const data = await apiPost<SubmitAssessmentResponse>(`/api/assessments/${assessment.assessmentId}/finish`, {});
      if (data.result) setResult(data.result);
      setAssessment(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '结算失败，请重试。');
    } finally {
      setFinishing(false);
    }
  }, [assessment, finishing]);

  const vocabularyDone = assessment ? null : result ?? learner?.currentVocabulary ?? null;

  const continueAfterAssessment = async () => {
    try {
      const { goals } = await apiGet<{ goals: Array<{ id: string; status: string }> }>('/api/goals');
      const active = goals.filter((goal) => goal.status === 'active');
      if (!active.length) { router.push('/goals'); return; }
      const readiness = await Promise.all(active.map(async goal => {
        const detail=await apiGet<{candidates:Array<{knowledgePointId:string;selection:string;learning:unknown}>}>(`/api/goals/${goal.id}`);
        const selected=detail.candidates.filter(candidate=>candidate.selection==='included');
        if(selected.length&&selected.some(candidate=>!candidate.learning)){
          await apiPost(`/api/goals/${goal.id}/selection`,{selections:selected.map(candidate=>({knowledgePointId:candidate.knowledgePointId,selection:'included'}))});
        }
        return {id:goal.id,ready:selected.length>0};
      }));
      const ready=readiness.find(goal=>goal.ready);
      const next=ready??readiness[0];
      if(!next){router.push('/goals');return;}
      router.push(next.ready?`/?goal=${next.id}`:`/goals/${next.id}`);
    } catch { router.push('/goals'); }
  };

  return (
    <PageShell title="词汇测评">
      {vocabularyDone ? (
        <section className="doc-card">
          <h2>词汇水平估计</h2>
          <p className="doc-muted">基于 {vocabularyDone.list.id} v{vocabularyDone.list.version} · {new Date(vocabularyDone.estimatedAt).toLocaleString()}</p>
          <p className="doc-muted">估计只覆盖已答题目所在的词段；未测频段不代表已确认掌握。Wilson 95% 区间反映样本不确定性。</p>
          <table className="doc-table">
            <thead><tr><th>词段</th><th>估计掌握率</th><th>认识 / 抽样</th><th>Wilson 95%</th></tr></thead>
            <tbody>
              {vocabularyDone.bands.map((band) => (
                <tr key={band.band}>
                  <td>{band.band}</td>
                  <td>{(band.knownProbability * 100).toFixed(0)}%</td>
                  <td>{band.knownCount} / {band.sampleCount}</td>
                  <td>{band.interval ? `${(band.interval.lower * 100).toFixed(0)}–${(band.interval.upper * 100).toFixed(0)}%` : '暂无样本'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {vocabularyDone.bands.length === 0 && <p className="doc-muted">没有已答题目，本次没有形成频段估计。</p>}
          <div className="doc-actions">
            <button className="primary-button" onClick={() => void continueAfterAssessment()}>{'继续开始学习'}</button>
            <button className="text-button" onClick={() => { setResult(null); void start(); }}>重新测评</button>
          </div>
        </section>
      ) : assessment ? (
        <section className="doc-card assessment-card">
          <p className="doc-muted">总进度 {assessment.answered} / {assessment.total} · 当前词段 {assessment.currentBand ?? assessment.tasks[cursor]?.band}：{assessment.bandAnswered} / {assessment.bandTotal}</p>
          {error && <p className="doc-error">{error}</p>}
          <h2 className="assessment-word">{assessment.tasks[cursor]?.lemma}</h2>
          <p className="doc-muted">只凭第一直觉：认识这个词吗？</p>
          <div className="doc-actions">
            <button className="primary-button" disabled={submitting} onClick={() => void answer(true)}>认识</button>
            <button className="doc-secondary-button" disabled={submitting} onClick={() => void answer(false)}>不认识</button>
          </div>
          <button className="text-button" disabled={finishing || submitting} onClick={() => void finishAssessment()}>{finishing ? '正在结算…' : '结束测评并结算'}</button>
        </section>
      ) : (
        <section className="doc-card">
          <h2>词汇自评定级</h2>
          <p className="doc-muted">
            测评从低到高逐段抽样，每段最多 12 个词族；只需自评“认识 / 不认识”，可随时结束并结算已答结果。20k 是 Nation 对受教育成年母语者词汇量的粗略参照，不代表阅读或口语理解所需的最低词汇量。完成后系统会估计各词段掌握概率，用于初始化学习流利度与调整出题难度。
          </p>
          {learner?.currentVocabulary && (
            <p className="doc-muted">已完成过测评，重新测评会覆盖当前词汇估计。</p>
          )}
          {error && <p className="doc-error">{error}</p>}
          <div className="doc-actions">
            <button className="primary-button" onClick={() => void start()}>开始测评</button>
          </div>
        </section>
      )}
    </PageShell>
  );
}
