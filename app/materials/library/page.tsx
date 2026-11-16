'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPatch, ApiError } from '@/lib/client/api';
import type { MaterialsResponse } from '@/lib/client/types';
import { PageShell } from '@/components/PageShell';

export default function MaterialsLibraryPage() {
  const router = useRouter();
  const [materials, setMaterials] = useState<MaterialsResponse['materials']>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState('');
  const [workingId, setWorkingId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await apiGet<MaterialsResponse>(`/api/materials${includeArchived ? '?includeArchived=true' : ''}`);
      setMaterials(data.materials);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '材料列表加载失败');
    }
  }, [includeArchived]);

  useEffect(() => { void load(); }, [load]);

  const setArchived = async (id: string, archived: boolean) => {
    setWorkingId(id);
    setError('');
    try {
      await apiPatch(`/api/materials/${id}`, { archived });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '材料状态更新失败');
    } finally {
      setWorkingId(null);
    }
  };

  return <PageShell title="材料管理">
    <section className="doc-card">
      <div className="doc-actions" style={{ justifyContent: 'space-between' }}>
        <h2>{includeArchived ? '材料库（含归档）' : '材料库'}</h2>
        <button className="doc-secondary-button" onClick={() => router.push('/materials')}>添加材料</button>
      </div>
      <div className="doc-actions">
        <button className="text-button" onClick={() => setIncludeArchived(value => !value)}>
          {includeArchived ? '只看未归档材料' : '查看归档材料'}
        </button>
      </div>
      {error && <p className="doc-error">{error}</p>}
      {!error && materials.length === 0 && <p className="doc-muted">{includeArchived ? '没有归档材料。' : '还没有材料，添加材料后可在这里查看分析状态和知识点。'}</p>}
      <ul className="doc-list">{materials.map(material => <li key={material.id}>
        <button className="doc-list-link" onClick={() => router.push(`/materials/${material.id}`)}>
          <strong>{material.title}{material.archivedAt ? '（已归档）' : ''}</strong>
          <span className="doc-muted">{material.format} · {material.analysis?.status === 'analyzed' ? `已分析，${material.analysis.itemCount} 个知识点` : material.analysis?.status === 'failed' ? '分析失败' : material.analysis?.status === 'pending' ? '待分析' : '未分析'} · {new Date(material.createdAt).toLocaleDateString()}</span>
        </button>
        <button className="text-button" onClick={() => router.push(`/materials/${material.id}`)}>查看详情 →</button>
        <button className="text-button" disabled={workingId === material.id} onClick={() => void setArchived(material.id, !material.archivedAt)}>
          {workingId === material.id ? '保存中…' : material.archivedAt ? '取消归档' : '归档'}
        </button>
      </li>)}</ul>
    </section>
  </PageShell>;
}
