'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '@/lib/client/api';
import type { ImportResultResponse, MaterialsResponse } from '@/lib/client/types';
import { PageShell } from '@/components/PageShell';

/** 材料导入（S04）：粘贴文本或上传 txt/md/pdf，查看分析出的知识点与过滤原因。 */
export default function MaterialsPage() {
  const router = useRouter();
  const [materials, setMaterials] = useState<MaterialsResponse['materials']>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResultResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<MaterialsResponse>('/api/materials');
      setMaterials(data.materials);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '材料列表加载失败。');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const readFile = useCallback(async (file: File) => {
    setError(null);
    setImporting(true);
    try {
      const isPdf = /\.pdf$/i.test(file.name);
      const body = isPdf
        ? { filename: file.name, base64: await fileToBase64(file) }
        : { filename: file.name, text: await file.text() };
      const data = await apiPost<ImportResultResponse>('/api/materials', body);
      setResult(data);
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
    setImporting(true);
    try {
      const data = await apiPost<ImportResultResponse>('/api/materials', {
        filename: `${title.trim() || 'pasted-material'}.txt`,
        title: title.trim() || undefined,
        text,
      });
      setResult(data);
      setText('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `导入失败：${err.message}` : '导入失败，请重试。');
    } finally {
      setImporting(false);
    }
  }, [title, text, load]);

  return (
    <PageShell title="材料与词库">
      <section className="doc-card">
        <h2>导入学习材料</h2>
        <p className="doc-muted">支持粘贴英文文本，或上传 .txt / .md / .pdf 文件。导入后自动提取术语、判定词义并过滤基础词。</p>
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
            {importing ? '导入分析中…' : '导入文本'}
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
        {error && <p className="doc-error">{error}</p>}
      </section>

      {result && (
        <section className="doc-card">
          <h2>分析结果：{result.material.title}</h2>
          <p className="doc-muted">识别 {result.analysis.itemCount} 个知识点，过滤 {result.analysis.unmatchedCount} 个词。</p>
          <ul className="doc-list">
            {result.analysis.items.map((item) => (
              <li key={item.knowledgePointId}>
                <strong>{item.lemma}</strong>
                {item.partOfSpeech && <em> {item.partOfSpeech}</em>}
                <span className="doc-muted"> · {item.definition}（出现 {item.occurrenceCount} 次）</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="doc-card">
        <h2>已导入材料</h2>
        {materials.length === 0 && <p className="doc-muted">还没有材料。</p>}
        <ul className="doc-list">
          {materials.map((material) => (
            <li key={material.id}>
              <strong>{material.title}</strong>
              <span className="doc-muted"> · {material.format} · {material.analysis ? `${material.analysis.itemCount} 个知识点` : '未分析'}</span>
              <button className="text-button" onClick={() => router.push('/goals')}>加入目标 →</button>
            </li>
          ))}
        </ul>
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
