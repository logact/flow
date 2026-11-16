'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import type { GoalDetailResponse } from '@/lib/client/types';
import { PageShell } from '@/components/PageShell';

type Selection = 'undecided' | 'included' | 'excluded';

const SELECTION_TEXT: Record<Selection, string> = {
  undecided: '待定',
  included: '学习',
  excluded: '不学',
};

/** 目标详情（S06 知识点选择 + S12 目标状态）。 */
export default function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [detail, setDetail] = useState<GoalDetailResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, Selection>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candidatePage, setCandidatePage] = useState(1);
  const candidatesPerPage = 10;
  const candidatePageCount = Math.max(1, Math.ceil((detail?.candidates.length ?? 0) / candidatesPerPage));
  const visibleCandidates = detail?.candidates.slice((candidatePage - 1) * candidatesPerPage, candidatePage * candidatesPerPage) ?? [];

  const load = useCallback(async () => {
    try {
      const data = await apiGet<GoalDetailResponse>(`/api/goals/${id}`);
      setDetail(data);
      const storageKey = `flow.goal-selection.${id}`;
      let stored: Record<string, Selection> = {};
      try {
        const raw = sessionStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          stored = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Selection] =>
            entry[1] === 'undecided' || entry[1] === 'included' || entry[1] === 'excluded',
          ));
        }
      } catch {
        sessionStorage.removeItem(storageKey);
      }
      setDraft(Object.fromEntries(data.candidates.map((item) => [
        item.knowledgePointId,
        stored[item.knowledgePointId] ?? item.selection,
      ])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '目标加载失败。');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = detail?.candidates.some((item) => draft[item.knowledgePointId] !== item.selection) ?? false;

  const save = useCallback(async () => {
    if (!detail) return;
    const changed = detail.candidates
      .filter((item) => draft[item.knowledgePointId] !== item.selection)
      .map((item) => ({ knowledgePointId: item.knowledgePointId, selection: draft[item.knowledgePointId] }));
    if (changed.length === 0) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const data = await apiPost<{ initialized: unknown[] }>(`/api/goals/${id}/selection`, { selections: changed });
      setMessage(`已保存：更新 ${changed.length} 项，新初始化 ${data.initialized.length} 个学习项。`);
      sessionStorage.removeItem(`flow.goal-selection.${id}`);
      await load();
    } catch (err) {
      const reason = err instanceof ApiError ? err.reason : null;
      setError(
        reason === 'assessment_incomplete'
          ? '请先完成词汇测评，再选择要学习的知识点。'
          : err instanceof ApiError ? err.message : '保存失败，请重试。',
      );
    } finally {
      setSaving(false);
    }
  }, [detail, draft, id, load]);

  useEffect(() => {
    if (!detail || !dirty || saving) return;
    const timer = window.setTimeout(() => { void save(); }, 500);
    return () => window.clearTimeout(timer);
  }, [detail, draft, dirty, saving, save]);

  useEffect(()=>{if(detail&&dirty)sessionStorage.setItem(`flow.goal-selection.${id}`,JSON.stringify(draft));},[detail,dirty,draft,id]);

  const changeStatus = useCallback(async (status: 'completed' | 'archived') => {
    setMessage(null);
    setError(null);
    try {
      await apiPost(`/api/goals/${id}/status`, { status });
      setMessage(status === 'completed' ? '目标已标记完成。' : '目标已归档。');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '状态更新失败。');
    }
  }, [id, load]);

  return (
    <PageShell title={detail?.goal.title ?? '目标详情'}>
      {error && <p className="doc-error">{error}</p>}
      {message && <p className="doc-notice">{message}</p>}

      {detail && (
        <>
          <section className="doc-card">
            <h2>{detail.goal.title}</h2>
            <p className="doc-muted">
              状态 {detail.goal.status} · 目标流利度 R {detail.goal.targetFluency.R} / P {detail.goal.targetFluency.P}
              {detail.materials.length > 0 && ` · 材料：${detail.materials.map((item) => item.title).join('、')}`}
            </p>
            {!detail.assessmentCompleted && (
              <p className="doc-notice">尚未完成词汇测评；包含新知识点时需要先测评才能初始化学习状态。</p>
            )}
            <div className="doc-actions"><button className="doc-secondary-button" onClick={() => {sessionStorage.setItem('flow.add-material-goal',id);router.push('/materials')}}>管理 / 添加材料</button></div>
            {detail.goal.status==='active'&&<div className="doc-actions"><button className="primary-button" onClick={()=>router.push(`/?goal=${id}`)}>开始学习</button></div>}
            {detail.goal.status === 'active' && (
              <div className="doc-actions">
                <button className="doc-secondary-button" onClick={() => void changeStatus('completed')}>标记完成</button>
                <button className="doc-secondary-button" onClick={() => void changeStatus('archived')}>归档</button>
              </div>
            )}
          </section>

          <section className="doc-card">
            <h2>候选知识点</h2>
            <p className="doc-muted">选择要学习的词；保存后新选中的词会初始化 R/P 流利度并进入每日排期。</p>
            <div className="doc-actions"><button className="text-button" onClick={() => setDraft(Object.fromEntries(detail.candidates.map(c=>[c.knowledgePointId,'included'] as const)))}>全选</button><button className="text-button" onClick={() => setDraft(Object.fromEntries(detail.candidates.map(c=>[c.knowledgePointId,'excluded'] as const)))}>全不选</button></div>
            <ul className="doc-list candidate-list">
              {visibleCandidates.map((candidate) => (
                <li key={candidate.knowledgePointId} className="candidate-item">
                  <div className="candidate-info">
                    <strong>{candidate.name}</strong>
                    {candidate.partOfSpeech && <em> {candidate.partOfSpeech}</em>}
                    {candidate.band && <span className="doc-tag">{candidate.band}</span>}
                    {candidate.learning && (
                      <span className="doc-muted">
                        R {candidate.learning.fluency.R.toFixed(2)} · P {candidate.learning.fluency.P.toFixed(2)}
                        {candidate.learning.graduated.R && candidate.learning.graduated.P ? ' · 已毕业' : ''}
                      </span>
                    )}
                    {candidate.definition && <p className="doc-muted">{candidate.definition}</p>}
                  </div>
                  <div className="candidate-toggle" role="group" aria-label={`选择 ${candidate.name}`}>
                    {(Object.keys(SELECTION_TEXT) as Selection[]).map((selection) => (
                      <button
                        key={selection}
                        className={draft[candidate.knowledgePointId] === selection ? 'active' : ''}
                        onClick={() => setDraft((value) => ({ ...value, [candidate.knowledgePointId]: selection }))}
                      >
                        {SELECTION_TEXT[selection]}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {candidatePageCount > 1 && <nav className="doc-actions" aria-label="知识点分页">
              <button className="doc-secondary-button" disabled={candidatePage <= 1} onClick={() => setCandidatePage(page => page - 1)}>上一页</button>
              <span className="doc-muted">第 {candidatePage} / {candidatePageCount} 页 · 共 {detail.candidates.length} 项</span>
              <button className="doc-secondary-button" disabled={candidatePage >= candidatePageCount} onClick={() => setCandidatePage(page => page + 1)}>下一页</button>
            </nav>}
            <div className="doc-actions">
              <button className="primary-button" disabled={saving || !dirty} onClick={() => void save()}>
                {saving ? '保存中…' : dirty ? '立即保存选择' : '已自动保存'}
              </button>
              <button className="text-button" onClick={() => router.push('/setup')}>去做词汇测评</button>
            </div>
          </section>
        </>
      )}
    </PageShell>
  );
}
