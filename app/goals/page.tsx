'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import type { GoalsResponse, MaterialsResponse } from '@/lib/client/types';
import { PageShell } from '@/components/PageShell';

/** 目标管理（S05）：创建目标、把已分析材料加入目标。 */
export default function GoalsPage() {
  const router = useRouter();
  const [goals, setGoals] = useState<GoalsResponse['goals']>([]);
  const [materials, setMaterials] = useState<MaterialsResponse['materials']>([]);
  const [title, setTitle] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [targetR, setTargetR] = useState(80);
  const [targetP, setTargetP] = useState(80);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [goalsData, materialsData] = await Promise.all([
        apiGet<GoalsResponse>('/api/goals'),
        apiGet<MaterialsResponse>('/api/materials'),
      ]);
      setGoals(goalsData.goals);
      setMaterials(materialsData.materials);
      const firstAnalyzed = materialsData.materials.find((item) => item.analysis?.status === 'analyzed');
      setMaterialId((current) => current || firstAnalyzed?.id || '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败，请刷新。');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    const material = materials.find((item) => item.id === materialId);
    if (!material?.analysis) return;
    setCreating(true);
    setError(null);
    try {
      await apiPost('/api/goals', {
        title: title.trim() || `${material.title} 目标`,
        targetFluency: { R: targetR, P: targetP },
        materialId: material.id,
        analysisId: material.analysis.id,
      });
      setTitle('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `创建失败：${err.message}` : '创建失败，请重试。');
    } finally {
      setCreating(false);
    }
  }, [title, targetR, targetP, materialId, materials, load]);

  return (
    <PageShell title="学习目标">
      <section className="doc-card">
        <h2>创建目标并加入材料</h2>
        <p className="doc-muted">目标是学习范围与流利度目标的载体；同一材料可加入多个目标。</p>
        <input className="doc-input" placeholder="目标名称" value={title} onChange={(event) => setTitle(event.target.value)} />
        <select className="doc-input" value={materialId} onChange={(event) => setMaterialId(event.target.value)}>
          <option value="">选择已分析材料…</option>
          {materials.filter((item) => item.analysis?.status === 'analyzed').map((material) => (
            <option key={material.id} value={material.id}>
              {material.title}（{material.analysis?.itemCount} 个知识点）
            </option>
          ))}
        </select>
        <div className="doc-form-row">
          <label>
            理解 R 目标
            <input type="number" min={0} max={100} step={5} value={targetR} onChange={(event) => setTargetR(Number(event.target.value))} />
          </label>
          <label>
            产出 P 目标
            <input type="number" min={0} max={100} step={5} value={targetP} onChange={(event) => setTargetP(Number(event.target.value))} />
          </label>
        </div>
        <div className="doc-actions">
          <button className="primary-button" disabled={creating || !materialId} onClick={() => void create()}>
            {creating ? '创建中…' : '创建目标'}
          </button>
        </div>
        {error && <p className="doc-error">{error}</p>}
      </section>

      <section className="doc-card">
        <h2>全部目标</h2>
        {goals.length === 0 && <p className="doc-muted">还没有目标。</p>}
        <ul className="doc-list">
          {goals.map((goal) => (
            <li key={goal.id}>
              <button className="doc-list-link" onClick={() => router.push(`/goals/${goal.id}`)}>
                <strong>{goal.title}</strong>
                <span className="doc-muted">
                  {goal.status} · 候选 {goal.candidateCount} · 已选 {goal.includedCount} · 目标 R {goal.targetFluency.R} / P {goal.targetFluency.P}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}
