'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import { PageShell } from '@/components/PageShell';
import { isMaterialAnalysisStale, materialAnalysisProgressLabel, materialAnalysisStatusLabel } from '@/lib/domain/material-analysis-status';

type Item = { knowledgePointId: string; lemma: string; definition: string; chineseMeaning: string | null; chineseMeaningStatus: 'pending'|'processing'|'complete'|'failed'; chineseMeaningError: string | null; partOfSpeech: string | null; occurrenceCount: number };
type Candidate = { lemma: string; candidates: Array<{ id: string; pos: string; gloss: string }>; occurrences: Array<{ sentence: string; context: string[] }>; status: string; error?: string };
type Detail = {
  material: { id: string; title: string; filename: string; format: string; createdAt: string };
  analysis: { id: string; status: 'pending' | 'analyzed' | 'failed'; createdAt: string; progress?: { stage: string; updatedAt: string }; errors: string[]; items: Item[]; candidates: Candidate[] } | null;
};

export default function MaterialDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'frequency' | 'name'>('frequency');
  const [selectedMeanings, setSelectedMeanings] = useState<string[]>([]);
  const [enrichingMeanings, setEnrichingMeanings] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Detail>(`/api/materials/${id}`));
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '材料详情加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => {
    const candidateProcessing = data?.analysis?.candidates?.some(candidate => candidate.status === 'processing') ?? false;
    if (data?.analysis?.status !== 'pending' && !candidateProcessing) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [data?.analysis?.status, data?.analysis?.candidates, load]);

  const stale = isMaterialAnalysisStale(data?.analysis?.status ?? null, data?.analysis?.createdAt);
  const analyze = async () => {
    setWorking(true);
    setError('');
    try {
      await apiPost(`/api/materials/${id}/analysis`, {});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '分析启动失败，请稍后重试');
      await load();
    } finally {
      setWorking(false);
    }
  };
  const resolveCandidates = async (lemmas: string[]) => {
    setResolving(true);
    setError('');
    try {
      const result = await apiPost<{ failedLemmas?: string[] }>(`/api/materials/${id}/analysis/resolve`, { lemmas, analysisId: data?.analysis?.id, operationId: crypto.randomUUID() });
      await load();
      if (result.failedLemmas?.length) setError(`以下候选解析失败：${result.failedLemmas.join('、')}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '候选解析失败，请重试');
      await load();
    } finally {
      setResolving(false);
    }
  };
  const enrichMeanings = async (ids: string[]) => {
    if (!ids.length) return;
    setEnrichingMeanings(true); setError('');
    try {
      const result = await apiPost<{ results: Array<{ knowledgePointId: string; status: string; error?: string }> }>(`/api/materials/${id}/analysis/meaning`, { knowledgePointIds: ids });
      await load();
      const failures = result.results.filter(item => item.status === 'failed');
      if (failures.length) setError(`有 ${failures.length} 个知识点释义补充失败，可单独重试。`);
      setSelectedMeanings(current => current.filter(kpId => failures.some(item => item.knowledgePointId === kpId)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '中文释义补充失败，请重试');
      await load();
    } finally { setEnrichingMeanings(false); }
  };
  const items = (data?.analysis?.items ?? [])
    .filter(item => !query || `${item.lemma} ${item.definition} ${item.partOfSpeech ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'frequency' ? b.occurrenceCount - a.occurrenceCount || a.lemma.localeCompare(b.lemma) : a.lemma.localeCompare(b.lemma));

  return <PageShell title={data?.material.title ?? '材料详情'}>
    {loading && !data && <section className="doc-card"><p className="doc-muted">正在加载材料…</p></section>}
    {error && !data && <section className="doc-card"><p className="doc-error">{error}</p><button className="primary-button" onClick={() => void load()}>重试加载</button></section>}
    {data && <>
      <section className="doc-card">
        <h2>{data.material.title}</h2>
        <p className="doc-muted">{data.material.filename} · {data.material.format} · 添加于 {new Date(data.material.createdAt).toLocaleDateString()}</p>
        <p>分析状态：{materialAnalysisStatusLabel(data.analysis?.status ?? null, 'detail')}</p>
        {!data.analysis && <p className="doc-muted">材料已保存。选择“开始分析”后才会提取并整理知识点。</p>}
        {data.analysis?.status === 'pending' && !stale && <p className="doc-muted">{materialAnalysisProgressLabel(data.analysis.progress?.stage) ?? '分析仍在处理中'}，页面会自动更新。{data.analysis.progress?.updatedAt && ` 最近更新：${new Date(data.analysis.progress.updatedAt).toLocaleTimeString()}`}</p>}
        {data.analysis?.status === 'pending' && stale && <p className="doc-error">分析进度已超过 6 分钟，可恢复并重试。原材料会复用。</p>}
        {data.analysis?.status === 'failed' && <p className="doc-error">{data.analysis.errors.join('；') || '分析失败，可以重试。'}{data.analysis.progress && ` 最后进展：${materialAnalysisProgressLabel(data.analysis.progress.stage) ?? data.analysis.progress.stage}（${new Date(data.analysis.progress.updatedAt).toLocaleTimeString()}）`}</p>}
        {data.analysis?.status !== 'analyzed' && <button className="primary-button" disabled={working || (data.analysis?.status === 'pending' && !stale)} onClick={() => void analyze()}>
          {working ? <><span className="submit-spinner" aria-hidden="true" />正在分析…</> : data.analysis?.status === 'pending' ? '恢复并重试分析' : data.analysis?.status === 'failed' ? '重试分析' : '开始分析'}
        </button>}
        {error && <p className="doc-error" role="alert">{error}</p>}
      </section>
      <section className="doc-card">
        <h2>分析知识点</h2>
        {data.analysis?.status === 'pending' && <p className="doc-muted">分析完成后会在这里显示该材料识别的知识点。</p>}
        {data.analysis?.status === 'failed' && <p className="doc-muted">本次分析没有可展示的知识点，可单独重试分析。</p>}
        {data.analysis?.status === 'analyzed' && <>
          <div className="doc-form-row">
            <input className="doc-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索知识点" aria-label="搜索知识点" />
            <label>排序<select className="doc-input" value={sort} onChange={event => setSort(event.target.value as 'frequency' | 'name')}><option value="frequency">材料出现次数</option><option value="name">词条名称</option></select></label>
          </div>
          <div className="doc-actions"><button className="text-button" onClick={() => setSelectedMeanings(items.filter(item => !item.chineseMeaning?.trim()).map(item => item.knowledgePointId))}>全选缺少中文释义</button><button className="text-button" onClick={() => setSelectedMeanings([])}>清除选择</button><span className="doc-muted">已选 {selectedMeanings.length}</span><button className="primary-button" disabled={enrichingMeanings || !selectedMeanings.length} onClick={() => void enrichMeanings(selectedMeanings)}>{enrichingMeanings ? '正在补充释义…' : '批量补充中文释义'}</button></div>
          {!items.length ? <p className="doc-muted">{data.analysis.items.length ? '没有匹配的知识点。' : '此材料没有分析出知识点。'}</p> : <ul className="doc-list">{items.map(item => <li key={item.knowledgePointId}><label><input type="checkbox" aria-label={`选择 ${item.lemma} 的中文释义`} checked={selectedMeanings.includes(item.knowledgePointId)} disabled={Boolean(item.chineseMeaning?.trim())} onChange={event => setSelectedMeanings(current => event.target.checked ? [...new Set([...current, item.knowledgePointId])] : current.filter(kpId => kpId !== item.knowledgePointId))}/> <strong>{item.lemma}</strong></label>{item.partOfSpeech && <span className="doc-muted"> · {item.partOfSpeech}</span>}<p className="doc-muted">{item.definition} · 在材料中出现 {item.occurrenceCount} 次</p><p className="doc-muted">中文释义：{item.chineseMeaning?.trim() || (item.chineseMeaningStatus === 'processing' ? '补充中…' : item.chineseMeaningStatus === 'failed' ? '补充失败' : '待补充')}</p>{item.chineseMeaningError && <p className="doc-error">{item.chineseMeaningError}</p>}{!item.chineseMeaning?.trim() && <button className="secondary-button" disabled={enrichingMeanings} onClick={() => void enrichMeanings([item.knowledgePointId])}>{item.chineseMeaningStatus === 'processing' ? '查看/恢复补充' : '单独补充/重试'}</button>}</li>)}</ul>}
          {!!data.analysis.candidates.length && <><h3>待解析候选（{data.analysis.candidates.filter(candidate => candidate.status !== 'resolved').length}）</h3><button className="primary-button" disabled={resolving || !data.analysis.candidates.some(candidate => candidate.status !== 'resolved')} onClick={() => void resolveCandidates(data.analysis!.candidates.filter(candidate => candidate.status !== 'resolved').map(candidate => candidate.lemma))}>{resolving ? '正在解析…' : '解析或恢复待处理知识点'}</button><ul className="doc-list">{data.analysis.candidates.map(candidate => <li key={candidate.lemma}><strong>{candidate.lemma}</strong><span className="doc-muted"> · {candidate.status === 'failed' ? '解析失败' : candidate.status === 'processing' ? '处理中或可恢复' : candidate.status === 'resolved' ? '已解析' : '待解析'} · {candidate.occurrences.length} 处语境</span><p className="doc-muted">{candidate.candidates.map(option => option.gloss).join('；')}</p>{candidate.occurrences.slice(0, 2).map((occurrence, index) => <p className="doc-muted" key={index}>{occurrence.sentence}</p>)}{candidate.error && <p className="doc-error">{candidate.error}</p>}{candidate.status !== 'resolved' && <button className="secondary-button" disabled={resolving} onClick={() => void resolveCandidates([candidate.lemma])}>{candidate.status === 'processing' ? '查看/恢复' : '重试'}</button>}</li>)}</ul></>}
        </>}
      </section>
    </>}
  </PageShell>;
}
