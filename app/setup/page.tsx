'use client';

import { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => {
    void apiGet<LearnerResponse>('/api/learner').then((data) => setLearner(data.learner)).catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const data = await apiPost<StartAssessmentResponse>('/api/assessments');
      setAssessment(data);
      setCursor(0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '测评创建失败，请重试。');
    }
  }, []);

  const answer = useCallback(async (known: boolean) => {
    if (!assessment || submitting) return;
    const task = assessment.tasks[cursor];
    if (!task) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiPost<SubmitAssessmentResponse>(`/api/assessments/${assessment.assessmentId}/attempts`, {
        taskId: task.id,
        known,
      });
      if (data.status === 'completed' && data.result) {
        setResult(data.result);
        setAssessment(null);
      } else {
        setCursor((value) => value + 1);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '提交失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  }, [assessment, cursor, submitting]);

  const vocabularyDone = result ?? learner?.currentVocabulary ?? null;

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
          <table className="doc-table">
            <thead><tr><th>词段</th><th>掌握概率</th><th>认识 / 抽样</th></tr></thead>
            <tbody>
              {vocabularyDone.bands.map((band) => (
                <tr key={band.band}>
                  <td>{band.band}</td>
                  <td>{(band.knownProbability * 100).toFixed(0)}%</td>
                  <td>{band.knownCount} / {band.sampleCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="doc-actions">
            <button className="primary-button" onClick={() => void continueAfterAssessment()}>{'继续开始学习'}</button>
            <button className="text-button" onClick={() => { setResult(null); void start(); }}>重新测评</button>
          </div>
        </section>
      ) : assessment ? (
        <section className="doc-card assessment-card">
          <p className="doc-muted">{cursor + 1} / {assessment.tasks.length} · 当前词段 {assessment.tasks[cursor]?.band}</p>
          <h2 className="assessment-word">{assessment.tasks[cursor]?.lemma}</h2>
          <p className="doc-muted">只凭第一直觉：认识这个词吗？</p>
          <div className="doc-actions">
            <button className="primary-button" disabled={submitting} onClick={() => void answer(true)}>认识</button>
            <button className="doc-secondary-button" disabled={submitting} onClick={() => void answer(false)}>不认识</button>
          </div>
        </section>
      ) : (
        <section className="doc-card">
          <h2>词汇自评定级</h2>
          <p className="doc-muted">
            当前从 1k–20k 词段分层抽样 100 个词族（每段 5 个），只需自评“认识 / 不认识”。
            20k 是 Nation 对受教育成年母语者词汇量的粗略参照，不代表阅读或口语理解所需的最低词汇量。完成后系统会估计各词段掌握概率，用于初始化学习流利度与调整出题难度。
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
