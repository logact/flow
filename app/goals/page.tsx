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
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [targetR, setTargetR] = useState(80);
  const [targetP, setTargetP] = useState(80);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftTouched, setDraftTouched] = useState(false);
  const [draftGoalId, setDraftGoalId] = useState('');
  const [candidates, setCandidates] = useState<Array<{id:string;name:string;definition:string}>>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [selectionOverrides,setSelectionOverrides]=useState<Record<string,boolean>>({});
  const [candidatesLoading,setCandidatesLoading]=useState(false);
  const [candidateError,setCandidateError]=useState<string|null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('flow.goal-draft');
      if (saved) {
        const draft = JSON.parse(saved) as { goalId?:string; title?: string; materialIds?: string[]; targetR?: number; targetP?: number; selectedKnowledge?:string[]; selectionOverrides?:Record<string,boolean> };
        setDraftGoalId(draft.goalId ?? '');
        setTitle(draft.title ?? ''); setMaterialIds(draft.materialIds ?? []);
        setSelectedKnowledge(draft.selectedKnowledge??[]);setSelectionOverrides(draft.selectionOverrides??{});
        if(draft.selectedKnowledge) setSelectionOverrides(draft.selectionOverrides??Object.fromEntries(draft.selectedKnowledge.map(id=>[id,true])));
        setTargetR(draft.targetR ?? 80); setTargetP(draft.targetP ?? 80);
      }
      if (saved) {
        setDraftRestored(true);
        setDraftTouched(true);
      }
    } catch { localStorage.removeItem('flow.goal-draft'); }
    finally { setDraftReady(true); }
  }, []);

  useEffect(() => {
    if (!draftReady || !draftTouched) return;
    localStorage.setItem('flow.goal-draft', JSON.stringify({ goalId:draftGoalId, title, materialIds, targetR, targetP, selectedKnowledge, selectionOverrides }));
  }, [draftReady, draftTouched, draftGoalId, title, materialIds, targetR, targetP, selectedKnowledge, selectionOverrides]);

  useEffect(() => {
    const selected=materials.filter(m=>materialIds.includes(m.id)&&m.analysis);
    if(!selected.length){setCandidates([]);setSelectedKnowledge([]);setCandidatesLoading(false);return;}
    let cancelled=false;setCandidatesLoading(true);setCandidateError(null);
    void Promise.all(selected.map(m=>apiGet<{analysis:{items:Array<{knowledgePointId:string;lemma:string;definition:string}>}}>(`/api/materials/${m.id}`))).then(results=>{
      const merged=new Map<string,{id:string;name:string;definition:string}>();
      results.forEach((r,i)=>r.analysis.items.forEach(item=>merged.set(item.knowledgePointId,{id:item.knowledgePointId,name:item.lemma,definition:item.definition})));
      if(cancelled)return;const list=[...merged.values()];setCandidates(list);setSelectedKnowledge(list.filter(x=>selectionOverrides[x.id]??true).map(x=>x.id));
    }).catch(()=>{if(!cancelled){setCandidates([]);setCandidateError('候选知识点加载失败，请重试后再创建目标。')}}).finally(()=>{if(!cancelled)setCandidatesLoading(false)});
    return ()=>{cancelled=true};
  },[materials,materialIds,selectionOverrides]);

  const load = useCallback(async () => {
    try {
      const [goalsData, materialsData] = await Promise.all([
        apiGet<GoalsResponse>('/api/goals'),
        apiGet<MaterialsResponse>('/api/materials'),
      ]);
      setGoals(goalsData.goals);
      setMaterials(materialsData.materials);
      const firstAnalyzed = materialsData.materials.find((item) => item.analysis?.status === 'analyzed');
      setMaterialIds((current) => current.length ? current : firstAnalyzed ? [firstAnalyzed.id] : []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败，请刷新。');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    const selected = materials.filter((item) => materialIds.includes(item.id) && item.analysis);
    if (!selected.length) {
      setError('请选择至少一项已完成分析的材料。');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const first=selected[0];
      const goalId=draftGoalId||crypto.randomUUID();
      setDraftGoalId(goalId);
      setDraftTouched(true);
      localStorage.setItem('flow.goal-draft',JSON.stringify({goalId,title,materialIds,targetR,targetP,selectedKnowledge,selectionOverrides}));
      await apiPost('/api/goals/create', {
        goalId,
        title:title.trim() || `${first.title} 目标`,
        targetFluency:{R:targetR,P:targetP},
        materials:selected.map(material=>({materialId:material.id,analysisId:material.analysis!.id})),
        selections:candidates.map(candidate=>({knowledgePointId:candidate.id,selection:selectedKnowledge.includes(candidate.id)?'included':'excluded'})),
      });
      localStorage.removeItem('flow.goal-draft');
      setDraftGoalId('');
      setDraftTouched(false);
      setDraftRestored(false);
      setDraftReady(true);
      setTitle('');
      setAdding(false);
      void load();
    } catch (err) {
      setError(err instanceof ApiError && err.reason === 'assessment_incomplete'
        ? '目标和材料已保存。请先完成词汇测评，再重新提交以初始化学习知识点。'
        : err instanceof ApiError ? `创建失败：${err.message}` : '创建失败，请重试。');
    } finally {
      setCreating(false);
    }
  }, [title, targetR, targetP, materialIds, materials, router, candidates, selectedKnowledge, draftGoalId, selectionOverrides]);

  return (
    <PageShell title="学习目标">
      {adding && <section className="doc-card">
        <h2>创建目标并加入材料</h2>
        <button className="doc-secondary-button" onClick={()=>setAdding(false)}>返回目标管理</button>
        {draftRestored && <p className="doc-notice">已恢复未完成的目标草稿。</p>}
        <p className="doc-muted">目标是学习范围与流利度目标的载体；同一材料可加入多个目标。</p>
        <div className="doc-actions"><button className="doc-secondary-button" onClick={()=>{localStorage.setItem('flow.goal-draft',JSON.stringify({goalId:draftGoalId,title,materialIds,targetR,targetP,selectedKnowledge,selectionOverrides}));router.push('/materials')}}>导入新材料</button></div>
        <input className="doc-input" placeholder="目标名称" value={title} onChange={(event) => {setTitle(event.target.value);setDraftTouched(true)}} />
        <fieldset className="doc-list"><legend>选择材料（可多选）</legend>{materials.filter(item=>item.analysis?.status==='analyzed').map(material=><label key={material.id} className="candidate-item"><input type="checkbox" checked={materialIds.includes(material.id)} onChange={e=>{setDraftTouched(true);setMaterialIds(v=>e.target.checked?[...v,material.id]:v.filter(id=>id!==material.id))}}/>{material.title}（{material.analysis?.itemCount} 个知识点）</label>)}</fieldset>
        {candidateError&&<p className="doc-error">{candidateError}</p>}
        {candidates.length>0&&<div className="doc-card"><h3>合并候选知识点（默认全选）</h3><div className="doc-actions"><button className="text-button" onClick={()=>{setDraftTouched(true);setSelectionOverrides(Object.fromEntries(candidates.map(x=>[x.id,true])));setSelectedKnowledge(candidates.map(x=>x.id))}}>全选</button><button className="text-button" onClick={()=>{setDraftTouched(true);setSelectionOverrides(Object.fromEntries(candidates.map(x=>[x.id,false])));setSelectedKnowledge([])}}>全不选</button></div><ul className="doc-list">{candidates.map(c=><li key={c.id}><label><input type="checkbox" checked={selectedKnowledge.includes(c.id)} onChange={e=>{setDraftTouched(true);setSelectionOverrides(v=>({...v,[c.id]:e.target.checked}));setSelectedKnowledge(v=>e.target.checked?[...new Set([...v,c.id])]:v.filter(id=>id!==c.id))}}/> <strong>{c.name}</strong> · {c.definition}</label></li>)}</ul></div>}
        <div className="doc-form-row">
          <label>
            理解 R 目标
            <input type="number" min={0} max={100} step={5} value={targetR} onChange={(event) => {setTargetR(Number(event.target.value));setDraftTouched(true)}} />
          </label>
          <label>
            产出 P 目标
            <input type="number" min={0} max={100} step={5} value={targetP} onChange={(event) => {setTargetP(Number(event.target.value));setDraftTouched(true)}} />
          </label>
        </div>
        <div className="doc-actions">
          <button className="primary-button" disabled={creating || candidatesLoading || Boolean(candidateError) || !materials.some(item=>materialIds.includes(item.id)&&item.analysis)} onClick={() => void create()}>
            {creating ? '创建中…' : candidatesLoading ? '加载知识点…' : '创建目标'}
          </button>
        </div>
        {error && <p className="doc-error">{error}</p>}
      </section>}

      <section className="doc-card">
        <div className="doc-actions" style={{justifyContent:'space-between', marginTop:0}}><h2>目标管理</h2><button className="doc-secondary-button" aria-label="添加目标" title="添加目标" onClick={()=>setAdding(true)} style={{fontSize:22,lineHeight:1,padding:'4px 12px'}}>＋</button></div>
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
