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
  const [requestId, setRequestId] = useState('');
  const [conflicts, setConflicts] = useState<Array<{materialId:string;materialTitle:string;goals:Array<{id:string;title:string}>}>>([]);
  const [candidates, setCandidates] = useState<Array<{id:string;name:string;definition:string;wordFrequency:number|null;wordFamilyFrequency:number|null;sources:Array<{id:string;title:string}>}>>([]);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateSourceIds, setCandidateSourceIds] = useState<string[]>([]);
  const [candidateSort, setCandidateSort] = useState<'name'|'wordFrequency'|'wordFamilyFrequency'>('wordFrequency');
  const [candidateSortDirection, setCandidateSortDirection] = useState<'desc'|'asc'>('desc');
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
        // Ignore goalId from drafts created by older versions.
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
    localStorage.setItem('flow.goal-draft', JSON.stringify({ title, materialIds, targetR, targetP, selectedKnowledge, selectionOverrides }));
  }, [draftReady, draftTouched, title, materialIds, targetR, targetP, selectedKnowledge, selectionOverrides]);

  useEffect(() => {
    const selected=materials.filter(m=>materialIds.includes(m.id)&&m.analysis);
    if(!selected.length){setCandidates([]);setSelectedKnowledge([]);setCandidatesLoading(false);return;}
    let cancelled=false;setCandidatesLoading(true);setCandidateError(null);
    const params=new URLSearchParams();selected.forEach(m=>params.append('materialId',m.id));
    void apiGet<{items:typeof candidates}>(`/api/knowledge/selection?${params}`).then(response=>{
      if(cancelled)return;const list=response.items;setCandidates(list);setSelectedKnowledge(list.filter(x=>selectionOverrides[x.id]??true).map(x=>x.id));
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

  const create = useCallback(async (confirmed = false) => {
    const selected = materials.filter((item) => materialIds.includes(item.id) && item.analysis);
    if (!selected.length) {
      setError('请选择至少一项已完成分析的材料。');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const first=selected[0];
      if (!confirmed) {
        const params = new URLSearchParams();
        selected.forEach(item => params.append('materialId', item.id));
        const check = await apiGet<{conflicts:typeof conflicts}>(`/api/goals/create?${params}`);
        if (check.conflicts.length) { setConflicts(check.conflicts); setCreating(false); return; }
      }
      const stableRequestId=requestId||crypto.randomUUID();
      setRequestId(stableRequestId);
      const created = await apiPost<{ goal: { id: string; title: string } }>('/api/goals/create', {
        requestId:stableRequestId,
        confirmedMaterialConflicts:confirmed,
        title:title.trim() || `${first.title} 目标`,
        targetFluency:{R:targetR,P:targetP},
        materials:selected.map(material=>({materialId:material.id,analysisId:material.analysis!.id})),
        selections:candidates.map(candidate=>({knowledgePointId:candidate.id,selection:selectedKnowledge.includes(candidate.id)?'included':'excluded'})),
      });
      localStorage.removeItem('flow.goal-draft');
      setRequestId(''); setConflicts([]);
      setDraftTouched(false);
      setDraftRestored(false);
      setDraftReady(true);
      setTitle('');
      setAdding(false);
      void load();
      router.push(`/goals/${created.goal.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'material_conflicts' && err.payload && typeof err.payload === 'object' && 'conflicts' in err.payload) {
        setConflicts((err.payload as { conflicts: typeof conflicts }).conflicts);
        setError('材料关联状态刚刚发生变化，请查看最新关联信息后确认。');
        return;
      }
      setError(err instanceof ApiError && err.reason === 'assessment_incomplete'
        ? '目标和材料已保存。请先完成词汇测评，再重新提交以初始化学习知识点。'
        : err instanceof ApiError ? `创建失败：${err.message}` : '创建失败，请重试。');
    } finally {
      setCreating(false);
    }
  }, [title, targetR, targetP, materialIds, materials, requestId, candidates, selectedKnowledge, router, load]);

  const candidateSources = [...new Map(candidates.flatMap(candidate => candidate.sources).map(source => [source.id, source])).values()];
  const visibleCandidates = candidates.filter(candidate =>
    (!candidateQuery.trim() || `${candidate.name} ${candidate.definition}`.toLocaleLowerCase().includes(candidateQuery.trim().toLocaleLowerCase()))
    && (!candidateSourceIds.length || candidateSourceIds.some(sourceId => candidate.sources.some(source => source.id === sourceId))),
  ).sort((a,b) => {
    const direction = candidateSortDirection === 'desc' ? 1 : -1;
    if (candidateSort === 'name') return direction * a.name.localeCompare(b.name);
    const aFrequency = candidateSort === 'wordFrequency' ? a.wordFrequency : a.wordFamilyFrequency;
    const bFrequency = candidateSort === 'wordFrequency' ? b.wordFrequency : b.wordFamilyFrequency;
    if (aFrequency === null) return bFrequency === null ? a.name.localeCompare(b.name) : 1;
    if (bFrequency === null) return -1;
    return direction * (bFrequency - aFrequency) || a.name.localeCompare(b.name);
  });

  return (
    <PageShell title="学习目标">
      {adding && <section className="doc-card">
        <h2>创建目标并加入材料</h2>
        <button className="doc-secondary-button" onClick={()=>setAdding(false)}>返回目标管理</button>
        {draftRestored && <p className="doc-notice">已恢复未完成的目标草稿。</p>}
        <p className="doc-muted">目标是学习范围与流利度目标的载体；同一材料可加入多个目标。</p>
        <div className="doc-actions"><button className="doc-secondary-button" onClick={()=>{localStorage.setItem('flow.goal-draft',JSON.stringify({title,materialIds,targetR,targetP,selectedKnowledge,selectionOverrides}));router.push('/materials')}}>导入新材料</button></div>
        <input className="doc-input" placeholder="目标名称" value={title} onChange={(event) => {setTitle(event.target.value);setRequestId('');setConflicts([]);setDraftTouched(true)}} />
        <fieldset className="doc-list"><legend>选择材料（可多选）</legend>{materials.filter(item=>item.analysis?.status==='analyzed').map(material=><label className="candidate-item" key={material.id}><input type="checkbox" checked={materialIds.includes(material.id)} onChange={e=>{setDraftTouched(true);setConflicts([]);setRequestId('');setMaterialIds(v=>e.target.checked?[...v,material.id]:v.filter(id=>id!==material.id))}}/>{material.title}（{material.analysis?.itemCount} 个已解析知识点）</label>)}</fieldset>
        {candidateError&&<p className="doc-error">{candidateError}</p>}
        {conflicts.length>0&&<div className="modal-backdrop" role="presentation" onClick={()=>{if(!creating)setConflicts([])}}><section className="doc-card source-popup" role="dialog" aria-modal="true" aria-labelledby="material-conflict-title" onClick={event=>event.stopPropagation()}><h2 id="material-conflict-title">所选材料已关联到其他目标</h2><ul className="doc-list">{conflicts.map(item=><li key={item.materialId}>{item.materialTitle}：{item.goals.map(goal=>goal.title).join('、')}</li>)}</ul><p className="doc-muted">同一材料可以加入多个目标。确认后会创建一个独立目标。</p><div className="doc-actions"><button className="doc-secondary-button" disabled={creating} onClick={()=>setConflicts([])}>返回修改</button><button className="primary-button" disabled={creating} onClick={()=>void create(true)}>{creating?'创建中…':'确认并继续'}</button></div></section></div>}
        {candidates.length>0&&<div className="doc-card">
          <h3>合并候选知识点（默认全选）</h3>
          <div className="doc-actions">
            <input className="doc-input" placeholder="搜索词条" aria-label="搜索知识点" value={candidateQuery} onChange={event=>setCandidateQuery(event.target.value)} />
            <label>排序<select className="doc-input" value={candidateSort} onChange={event=>setCandidateSort(event.target.value as typeof candidateSort)}><option value="wordFrequency">单词词频</option><option value="wordFamilyFrequency">词族词频</option><option value="name">词条名称</option></select></label>
            <button className="doc-secondary-button" aria-label={`当前${candidateSortDirection==='desc'?'降序':'升序'}，切换排序方向`} onClick={()=>setCandidateSortDirection(direction=>direction==='desc'?'asc':'desc')}>{candidateSortDirection==='desc'?'降序 ↓':'升序 ↑'}</button>
          </div>
          <p className="doc-muted">当前按{candidateSort==='wordFrequency'?'单词词频':candidateSort==='wordFamilyFrequency'?'词族词频':'词条名称'}{candidateSortDirection==='desc'?'降序':'升序'}排列；来源多选按“任一来源匹配”筛选。</p>
          <fieldset className="doc-list"><legend>来源材料（可多选）</legend>{candidateSources.map(source=><label key={source.id} className="candidate-item"><input type="checkbox" checked={candidateSourceIds.includes(source.id)} onChange={event=>setCandidateSourceIds(ids=>event.target.checked?[...ids,source.id]:ids.filter(id=>id!==source.id))}/>{source.title}</label>)}{candidateSourceIds.length>0&&<button className="text-button" onClick={()=>setCandidateSourceIds([])}>清除来源筛选</button>}</fieldset>
          <div className="doc-actions"><button className="text-button" onClick={()=>{setRequestId('');setConflicts([]);setDraftTouched(true);setSelectionOverrides(Object.fromEntries(candidates.map(x=>[x.id,true])));setSelectedKnowledge(candidates.map(x=>x.id))}}>全选</button><button className="text-button" onClick={()=>{setRequestId('');setConflicts([]);setDraftTouched(true);setSelectionOverrides(Object.fromEntries(candidates.map(x=>[x.id,false])));setSelectedKnowledge([])}}>全不选</button><span className="doc-muted">显示 {visibleCandidates.length} / {candidates.length} · 已选 {selectedKnowledge.length}</span></div>
          <ul className="doc-list">{visibleCandidates.map(c=><li key={c.id}><label><input type="checkbox" checked={selectedKnowledge.includes(c.id)} onChange={event=>{setRequestId('');setConflicts([]);setDraftTouched(true);setSelectionOverrides(value=>({...value,[c.id]:event.target.checked}));setSelectedKnowledge(value=>event.target.checked?[...new Set([...value,c.id])]:value.filter(id=>id!==c.id))}}/> <strong>{c.name}</strong> · {c.definition}<span className="doc-muted"> · 单词词频 {c.wordFrequency??'暂无'} · 词族词频 {c.wordFamilyFrequency??'暂无'}</span></label></li>)}</ul>
          {!visibleCandidates.length&&<p className="doc-muted">没有匹配的知识点。</p>}
        </div>}
        <div className="doc-form-row">
          <label>
            理解 R 目标
            <input type="number" min={0} max={100} step={5} value={targetR} onChange={(event) => {setRequestId('');setConflicts([]);setTargetR(Number(event.target.value));setDraftTouched(true)}} />
          </label>
          <label>
            产出 P 目标
            <input type="number" min={0} max={100} step={5} value={targetP} onChange={(event) => {setRequestId('');setConflicts([]);setTargetP(Number(event.target.value));setDraftTouched(true)}} />
          </label>
        </div>
        <div className="doc-actions">
          <button className="primary-button" disabled={creating || candidatesLoading || Boolean(candidateError) || conflicts.length>0 || !materials.some(item=>materialIds.includes(item.id)&&item.analysis)} onClick={() => void create()}>
            {creating ? '创建中…' : candidatesLoading ? '加载知识点…' : '创建目标'}
          </button>
        </div>
        {error && <p className="doc-error">{error}</p>}
      </section>}

      <section className="doc-card">
        <div className="doc-actions" style={{justifyContent:'space-between', marginTop:0}}><h2>目标管理</h2><div className="doc-actions"><button className="doc-secondary-button" onClick={()=>router.push('/materials/library')}>材料管理</button><button className="doc-secondary-button" aria-label="添加目标" title="添加目标" onClick={()=>setAdding(true)} style={{fontSize:22,lineHeight:1,padding:'4px 12px'}}>＋</button></div></div>
        {goals.length === 0 && <p className="doc-muted">还没有目标。</p>}
        <div className="goal-management-grid">
          {goals.map((goal) => (
            <article className="goal-management-card" key={goal.id}>
              <button className="doc-list-link" onClick={() => router.push(`/goals/${goal.id}`)} aria-label={`打开目标：${goal.title}`}>
                <strong>{goal.title}</strong>
                <span className="doc-muted">
                  {goal.status} · 候选 {goal.candidateCount} · 已选 {goal.includedCount} · 目标 R {goal.targetFluency.R} / P {goal.targetFluency.P}
                </span>
              </button>
              <button className="text-button goal-open-action" onClick={() => router.push(`/goals/${goal.id}`)}>查看目标 →</button>
            </article>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
