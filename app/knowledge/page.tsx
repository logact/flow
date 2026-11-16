'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiError } from '@/lib/client/api';
import { PageShell } from '@/components/PageShell';

type Item = { id: string; name: string; definition: string; score: number | null; wordFamily: string | null; materials: Array<{ id: string; title: string }> };
type Data = { items: Item[]; sources: Array<{ id: string; title: string }>; page: number; total: number; totalPages: number };

export default function KnowledgePage() {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [sort, setSort] = useState('name');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), q: query, sort });
      sourceIds.forEach((id) => params.append('sourceId', id));
      setData(await apiGet<Data>(`/api/knowledge?${params}`));
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '知识点加载失败');
    }
  }, [page, query, sourceIds, sort]);
  useEffect(() => { void load(); }, [load]);

  return <PageShell title="全局知识点库">
    <section className="doc-card knowledge-library">
      <p className="doc-muted knowledge-count">共收录 {data?.total ?? '…'} 个知识点。</p>
      <div className="knowledge-controls">
        <input className="doc-input" aria-label="搜索知识点" placeholder="搜索词条、释义或材料" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
        <select className="doc-input" aria-label="排序方式" value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">按名称</option><option value="proficiency">按熟练度</option></select>
      </div>
      <fieldset className="knowledge-source-filter">
        <legend>来源材料（可多选）</legend>
        <div className="knowledge-source-options">{data?.sources.map((source) => <label key={source.id} className={`knowledge-source-option${sourceIds.includes(source.id) ? ' selected' : ''}`}>
          <input type="checkbox" checked={sourceIds.includes(source.id)} onChange={(e) => { setPage(1); setSourceIds((ids) => e.target.checked ? [...ids, source.id] : ids.filter((id) => id !== source.id)); }} />
          <span>{source.title}</span>
        </label>)}</div>
        {sourceIds.length > 0 && <button className="text-button knowledge-clear" onClick={() => { setSourceIds([]); setPage(1); }}>清除筛选（{sourceIds.length}）</button>}
      </fieldset>
      {error && <p className="doc-error">{error}</p>}
      <ul className="knowledge-list">{data?.items.map((item) => <li key={item.id} className="knowledge-item">
        <h2>{item.name}</h2>
        <p className="knowledge-definition">{item.definition}</p>
        <p className="knowledge-meta">熟练度 {item.score ?? '暂无'} <span>·</span> 词族 {item.wordFamily ?? '暂无'}</p>
        <p className="knowledge-sources">来源材料：{item.materials.length ? item.materials.map((material, i) => <span key={material.id}>{i > 0 ? '、' : ''}<a href={`/materials/${material.id}`}>{material.title}</a></span>) : '暂无'}</p>
        <button className="text-button knowledge-detail-link" onClick={() => location.assign(`/knowledge/${item.id}`)}>查看详情 →</button>
      </li>)}</ul>
      <div className="doc-actions knowledge-pagination"><button className="doc-secondary-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button><span>第 {data?.page ?? page} / {data?.totalPages ?? 1} 页</span><button className="doc-secondary-button" disabled={!data || page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button></div>
    </section>
  </PageShell>;
}
