'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import type { MaterialsResponse } from '@/lib/client/types';
import { PageShell } from '@/components/PageShell';
import { isMaterialAnalysisStale, materialAnalysisStatusLabel } from '@/lib/domain/material-analysis-status';

/** 材料导入（S04）：粘贴文本或上传 txt/md/pdf，查看分析出的知识点与过滤原因。 */
export default function MaterialsPage() {
  const router = useRouter();
  const [materials, setMaterials] = useState<MaterialsResponse['materials']>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [analyzingIds, setAnalyzingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [targetGoal,setTargetGoal]=useState('');
  const [hasGoalDraft,setHasGoalDraft]=useState(false);
  const [goals,setGoals]=useState<Array<{id:string;title:string;status:string}>>([]);
  const [materialPage, setMaterialPage] = useState(1);
  const materialsPerPage = 8;
  const orderedMaterials = [...materials].sort((a, b) =>
    (a.analysis?.frequencyRank ?? Infinity) - (b.analysis?.frequencyRank ?? Infinity)
    || (b.analysis?.frequentTermCount ?? 0) - (a.analysis?.frequentTermCount ?? 0)
    || a.title.localeCompare(b.title),
  );
  const pageCount = Math.max(1, Math.ceil(orderedMaterials.length / materialsPerPage));
  const visibleMaterials = orderedMaterials.slice((materialPage - 1) * materialsPerPage, materialPage * materialsPerPage);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [data,goalData] = await Promise.all([apiGet<MaterialsResponse>('/api/materials'),apiGet<{goals:Array<{id:string;title:string;status:string}>}>('/api/goals')]);
      setMaterials(data.materials);
      setMaterialPage(page => Math.min(page, Math.max(1, Math.ceil(data.materials.length / materialsPerPage))));
      const activeGoals=goalData.goals.filter(goal=>goal.status==='active');
      setGoals(activeGoals);
      setTargetGoal(current=>activeGoals.some(goal=>goal.id===current)?current:'');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '材料列表加载失败。');
    }
  }, []);

  useEffect(() => {
    setTargetGoal(sessionStorage.getItem('flow.add-material-goal')??'');
    setHasGoalDraft(Boolean(localStorage.getItem('flow.goal-draft')));
    void load();
  }, [load]);

  const readFile = useCallback(async (file: File) => {
    setError(null);
      setNotice(null);
    setImporting(true);
    try {
      const isPdf = /\.pdf$/i.test(file.name);
      const body = isPdf
        ? { filename: file.name, base64: await fileToBase64(file) }
        : { filename: file.name, text: await file.text() };
      const data = await apiPost<{material:{id:string;title:string}}>('/api/materials', body);
      setNotice(`材料“${data.material.title}”已保存，可在列表中单独启动分析。`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `导入失败：${err.message}` : '导入失败，请重试。');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [load]);

  const importText = useCallback(async () => {
    if (!text.trim()) return;
    setError(null);
    setNotice(null);
    setImporting(true);
    try {
      const data = await apiPost<{material:{id:string;title:string}}>('/api/materials', {
        filename: `${title.trim() || 'pasted-material'}.txt`,
        title: title.trim() || undefined,
        text,
      });
      setNotice(`材料“${data.material.title}”已保存，可在列表中单独启动分析。`);
      setText('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `导入失败：${err.message}` : '导入失败，请重试。');
    } finally {
      setImporting(false);
    }
  }, [title, text, load]);

  const analyzeMaterial = useCallback(async (materialId: string) => {
    setAnalyzingIds(ids => [...new Set([...ids, materialId])]);
    setError(null);
    try {
      await apiPost(`/api/materials/${materialId}/analysis`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `分析失败：${err.message}` : '分析失败，可重试。');
      await load();
    } finally {
      setAnalyzingIds(ids => ids.filter(id => id !== materialId));
    }
  }, [load]);

  return (
    <PageShell title="导入学习材料">
      <section className="doc-card">
        <h2>导入学习材料</h2>
        {hasGoalDraft&&<p className="doc-notice">正在为目标创建流程导入材料。<button className="text-button" onClick={()=>router.push('/goals')}>返回继续创建目标</button></p>}
        <p className="doc-muted">支持粘贴英文文本，或上传 .txt / .md / .pdf 文件。保存后可单独启动分析。</p>
        <input className="doc-input" placeholder="材料标题（可选）" value={title} onChange={(event) => setTitle(event.target.value)} />
        <textarea
          className="doc-textarea"
          placeholder="Paste English text here…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
        />
        <div className="doc-actions">
          <button className="primary-button" disabled={importing || !text.trim()} onClick={() => void importText()}>
            {importing ? '正在保存…' : '保存文本'}
          </button>
          <label className="doc-secondary-button doc-file-button">
            {importing ? '读取中…' : '上传文件'}
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,.pdf"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </label>
        </div>
        {notice&&<p className="doc-notice">{notice}{targetGoal&&<button className="text-button" onClick={()=>router.push(`/goals/${targetGoal}`)}>返回当前目标继续编辑</button>}</p>}{error && <p className="doc-error">{error}</p>}
      </section>

      <section className="doc-card">
        <h2>已导入材料</h2>
        {materials.length === 0 && <p className="doc-muted">还没有材料。</p>}
        {materials.length > 0 && <p className="doc-muted">按词频排序（高频优先） · 每页 {materialsPerPage} 项</p>}
        <ul className="doc-list">
          {visibleMaterials.map((material) => (
            <li key={material.id}>
              <strong>{material.title}</strong>
              <span className="doc-muted"> · {material.format} · {material.analysis?.status === 'analyzed' ? `${material.analysis.itemCount} 个知识点 · ` : ''}{materialAnalysisStatusLabel(material.analysis?.status ?? null, 'list')}{isMaterialAnalysisStale(material.analysis?.status === 'pending' ? 'pending' : null, material.analysis?.createdAt) ? ' · 已超时，可恢复并重试' : ''}</span>
              {material.analysis?.status !== 'analyzed' && <button className="text-button" disabled={analyzingIds.includes(material.id) || (material.analysis?.status === 'pending' && !isMaterialAnalysisStale('pending', material.analysis.createdAt))} onClick={() => void analyzeMaterial(material.id)}>{analyzingIds.includes(material.id) ? '分析中…' : material.analysis?.status === 'pending' ? '恢复并重试' : material.analysis?.status === 'failed' ? '重试分析' : '开始分析'}</button>}
              <label className="doc-muted">加入目标
                <select className="doc-input" value={targetGoal} onChange={event=>setTargetGoal(event.target.value)} aria-label={`选择用于 ${material.title} 的目标`}>
                  <option value="">选择活动目标…</option>{goals.map(goal=><option key={goal.id} value={goal.id}>{goal.title}</option>)}
                </select>
              </label>
              <button className="text-button" disabled={!targetGoal||material.analysis?.status!=='analyzed'} onClick={async () => {if(!targetGoal||material.analysis?.status!=='analyzed')return;setError(null);setNotice(null);try{await apiPost('/api/goals',{goalId:targetGoal,materialId:material.id,analysisId:material.analysis.id});setNotice(`“${material.title}”已加入目标。`);await load();}catch(e){setError(e instanceof ApiError?e.message:'加入目标失败');}}}>加入目标 →</button>
            </li>
          ))}
        </ul>
        {pageCount > 1 && <nav className="doc-actions" aria-label="材料分页">
          <button className="doc-secondary-button" disabled={materialPage <= 1} onClick={() => setMaterialPage(page => page - 1)}>上一页</button>
          <span className="doc-muted">第 {materialPage} / {pageCount} 页</span>
          <button className="doc-secondary-button" disabled={materialPage >= pageCount} onClick={() => setMaterialPage(page => page + 1)}>下一页</button>
        </nav>}
      </section>
    </PageShell>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
