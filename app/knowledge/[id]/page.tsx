'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import { PageShell } from '@/components/PageShell';

type Pronunciation = { ipa: string | null; audioUrl: string | null; source: string; sourceUrl: string; queriedAt: string } | null;
type Detail = {
  item: { id: string; name: string; definition: string; wordFamily: string | null; pronunciation: Pronunciation; pronunciationStatus: 'pending' | 'processing' | 'complete' | 'failed'; pronunciationSupported: boolean };
  learning: { R: { fluency: number; review: { dueAt: string; graduated: boolean } }; P: { fluency: number; review: { dueAt: string; graduated: boolean } } } | null;
  future: Array<{ axis: string; dueAt: string; intervalDays: number }>;
  history: Array<{ id: string; date: string; status: string; taskType?: string; hasSettlement: boolean; judgement: unknown }>;
  timeline: Array<{ date: string; dimension: string; before: number; after: number }>;
  materials: Array<{ id: string; title: string }>;
};

export default function KnowledgeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [pronunciationWorking, setPronunciationWorking] = useState(false);
  const [pronunciationMessage, setPronunciationMessage] = useState('');
  const load = useCallback(async () => {
    const detail = await apiGet<Detail>(`/api/knowledge/${id}`);
    setData(detail);
    return detail;
  }, [id]);
  useEffect(() => { void load().catch((e) => setError(e instanceof ApiError ? e.message : '知识点详情加载失败')); }, [load]);

  const retryPronunciation = async () => {
    setPronunciationWorking(true);
    setPronunciationMessage('');
    try {
      const result = await apiPost<{ available: boolean }>(`/api/knowledge/${id}/pronunciation`, {});
      await load();
      setPronunciationMessage(result.available ? '发音信息已更新。' : '词典暂未提供匹配发音，可以稍后再试。');
    } catch (e) {
      setPronunciationMessage(e instanceof ApiError ? e.message : '查询失败，请稍后重试。');
    } finally {
      setPronunciationWorking(false);
    }
  };

  return <PageShell title={data?.item.name ?? '知识点详情'}><section className="doc-card">
    {error && <p className="doc-error">{error}</p>}
    {data && <>
      <p>{data.item.definition}</p>
      <p className="doc-muted">词族：{data.item.wordFamily ?? '暂无'} · 来源材料：{data.materials.length ? data.materials.map((m, i) => <span key={m.id}>{i > 0 ? '、' : ''}<a href={`/materials/${m.id}`}>{m.title}</a></span>) : '暂无来源材料'}</p>
      {data.item.pronunciationSupported && <section className="knowledge-pronunciation">
        <h2>发音</h2>
        {data.item.pronunciationStatus === 'pending' && <p className="doc-muted">尚未查询发音。</p>}
        {data.item.pronunciationStatus === 'processing' && <p className="doc-muted">正在补充发音。</p>}
        {data.item.pronunciationStatus === 'failed' && <p className="doc-error">发音查询失败；知识点分析结果仍可正常使用。</p>}
        {data.item.pronunciation?.ipa ? <p>音标：{data.item.pronunciation.ipa}</p> : <p className="doc-muted">音标暂缺</p>}
        {data.item.pronunciation?.audioUrl && <audio controls src={data.item.pronunciation.audioUrl}>当前浏览器不支持音频播放。</audio>}
        {data.item.pronunciation?.source && <p className="doc-muted">来源：<a href={data.item.pronunciation.sourceUrl} target="_blank" rel="noreferrer">{data.item.pronunciation.source}</a></p>}
        <button className="text-button" disabled={pronunciationWorking} onClick={() => void retryPronunciation()}>{pronunciationWorking ? '正在查询…' : '重新查询发音'}</button>
        {pronunciationMessage && <p className="doc-muted" role="status">{pronunciationMessage}</p>}
      </section>}
      <h2>当前学习状态</h2>{data.learning ? <p>R {data.learning.R.fluency} · P {data.learning.P.fluency}</p> : <p className="doc-muted">尚无学习状态。</p>}
      <h2>未来复习计划</h2>{data.future.length ? <ul className="doc-list">{data.future.map(t => <li key={t.axis}>{t.axis} · {t.dueAt} · 间隔 {t.intervalDays} 天</li>)}</ul> : <p className="doc-muted">{data.learning ? '没有待复习的未来安排。' : '尚无学习状态，暂无未来复习计划。'}</p>}
      <h2>学习记录</h2>{data.history.length ? <ul className="doc-list">{data.history.map(a => <li key={a.id}>{a.date} · {a.taskType ?? '任务'} · {a.hasSettlement ? '已结算' : a.status === 'completed' ? '已完成（没有分数结算记录）' : `有作答记录（${a.status}，未结算）`}</li>)}</ul> : <p className="doc-muted">暂无学习记录。</p>}
      <h2>分数变化</h2>{data.timeline.length ? <ol className="doc-list">{data.timeline.map((x, i) => <li key={`${x.date}-${i}`}>{x.date} · {x.dimension}：{x.before} → {x.after}</li>)}</ol> : <p className="doc-muted">{data.history.length ? '有学习事件，但没有可用的分数变化记录。' : '暂无分数变化记录。'}</p>}
    </>}
  </section></PageShell>;
}
