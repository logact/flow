'use client';

import { NewAlgorithmGoalImport } from '@/components/new-algorithm-goal-import';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { SAMPLE_TEXT } from '@/lib/vocab-data';

type GoalType = 'wordlist' | 'book' | 'ielts';

type GoalProgress = {
  id: number;
  type: string;
  title: string;
  created_at: number;
  target: {
    vocab_size?: number;
    reading_wpm?: number;
    writing_wpm?: number;
    source_id?: number;
  } | null;
  total: number;
  glossMissing: number;
  graduated: number;
  mastered: number;
  integrable: number;
  inPipeline: number;
  fresh: number;
  fluency: number;
  attainment: number; // 双轴均达个人目标的 KP 的词频加权占比（0–1）
};

type GoalWord = { id: number; chunk: string; meaning: string };
const GLOSS_PAGE_SIZE = 100;

type BookAnalysis = {
  sourceId: number;
  title: string;
  durationMs: number;
  totalTokens: number;
  totalSentences: number;
  uniqueWords: number;
  contentWords: number;
  properNouns: number;
  coverageCurve: { top: number; ratio: number }[];
  knownCoverage: number | null;
  topWords: { word: string; count: number; perMillion: number; isProper: boolean }[];
};

type PdfJob = {
  id: number;
  title: string;
  status: string;
  total_pages: number;
  processed_pages: number;
  ocr_pages: number;
  source_id: number | null;
  error: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  wordlist: '词表',
  book: '书',
  ielts: 'IELTS',
};

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

export default function GoalsPage() {
  const [type, setType] = useState<GoalType>('wordlist');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [count, setCount] = useState(30);
  const [score, setScore] = useState('7.0');
  const [message, setMessage] = useState('');
  const [goals, setGoals] = useState<GoalProgress[]>([]);
  const [analysis, setAnalysis] = useState<BookAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [pdfJob, setPdfJob] = useState<PdfJob | null>(null);
  const [glossGoalId, setGlossGoalId] = useState<number | null>(null);
  const [glossWords, setGlossWords] = useState<GoalWord[]>([]);
  const [glossTotal, setGlossTotal] = useState(0);
  const [glossOffset, setGlossOffset] = useState(0);
  const [glossDrafts, setGlossDrafts] = useState<Record<number, string>>({});
  const [glossSuggestions, setGlossSuggestions] = useState<Record<number, string>>({});
  const [glossBusy, setGlossBusy] = useState<number | null>(null);
  const [glossMessage, setGlossMessage] = useState('');

  // PDF 任务进度轮询：完成后自动拉取分析摘要进入预览
  useEffect(() => {
    if (!pdfJob || pdfJob.status !== 'processing') return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/books/jobs?id=${pdfJob.id}`, { cache: 'no-store' });
      const { job } = await res.json();
      setPdfJob(job);
      if (job.status === 'done') {
        const sum = await fetch(`/api/books?id=${job.source_id}`, { cache: 'no-store' });
        setAnalysis(await sum.json());
      } else if (job.status === 'error') {
        setMessage(`错误：PDF 解析失败：${job.error}`);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pdfJob]);

  const load = useCallback(async () => {
    const res = await fetch('/api/goals', { cache: 'no-store' });
    setGoals((await res.json()).goals);
  }, []);

  const loadGlossPage = useCallback(async (goalId: number, offset = 0) => {
    const res = await fetch(`/api/goals?words=${goalId}&offset=${offset}&limit=${GLOSS_PAGE_SIZE}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) {
      setGlossMessage(`错误：${data.error}`);
      return;
    }
    const words = data.words as GoalWord[];
    setGlossGoalId(goalId);
    setGlossOffset(offset);
    setGlossWords(words);
    setGlossTotal(data.total);
    setGlossDrafts(Object.fromEntries(words.map((word) => [word.id, word.meaning])));
    setGlossSuggestions({});
    setGlossMessage('');
  }, []);

  const saveGloss = async (wordId: number, meaning = glossDrafts[wordId] ?? '') => {
    setGlossBusy(wordId);
    setGlossMessage('');
    try {
      const res = await fetch('/api/goals', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wordId, meaning }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGlossWords((current) => current.map((word) => word.id === wordId ? { ...word, meaning: data.meaning } : word));
      setGlossDrafts((current) => ({ ...current, [wordId]: data.meaning }));
      setGlossSuggestions((current) => {
        const next = { ...current };
        delete next[wordId];
        return next;
      });
      setGlossMessage('释义已保存。');
      await load();
    } catch (error) {
      setGlossMessage(`错误：${(error as Error).message}`);
    } finally {
      setGlossBusy(null);
    }
  };

  const suggestGloss = async (wordId: number) => {
    setGlossBusy(wordId);
    setGlossMessage('');
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'suggest_gloss', wordId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGlossSuggestions((current) => ({ ...current, [wordId]: data.suggestion }));
    } catch (error) {
      setGlossMessage(`错误：${(error as Error).message}`);
    } finally {
      setGlossBusy(null);
    }
  };

  const removeGoal = useCallback(
    async (g: GoalProgress) => {
      if (!confirm(`删除目标「${g.title}」？其下 ${g.total} 个语块（含已掌握的）将一并移除。`))
        return;
      const res = await fetch(`/api/goals?id=${g.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) setMessage(`错误：${data.error}`);
      load();
    },
    [load]
  );

  useEffect(() => {
    load();
  }, [load]);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setFileText(String(reader.result));
      setFileName(`${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`);
      setAnalysis(null);
      setPdfJob(null);
    };
    reader.readAsText(file);
  };

  const uploadPdf = async (file: File) => {
    setMessage('');
    setAnalysis(null);
    setFileName('');
    setFileText('');
    const form = new FormData();
    form.append('file', file);
    form.append('title', title || file.name.replace(/\.pdf$/i, ''));
    const res = await fetch('/api/books/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) {
      setMessage(`错误：${data.error}`);
      return;
    }
    setPdfJob({
      id: data.jobId,
      title: file.name,
      status: 'processing',
      total_pages: 0,
      processed_pages: 0,
      ocr_pages: 0,
      source_id: null,
      error: null,
    });
  };

  const analyze = async () => {
    const payload = fileText || text;
    if (!payload.trim()) {
      setMessage('错误：请先上传文件或粘贴文本');
      return;
    }
    setAnalyzing(true);
    setMessage('');
    try {
      const res = await fetch('/api/books', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, text: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAnalysis(data);
    } catch (e) {
      setMessage(`错误：${(e as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const submit = async () => {
    setMessage('');
    const body =
      type === 'book' && analysis
        ? // 书名为空时沿用分析结果里的书名（分析阶段允许留空兜底为"未命名书籍"）
          { type, title: title || analysis.title, sourceId: analysis.sourceId, count }
        : { type, title, text, count, score };
    const res = await fetch('/api/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(`错误：${data.error}`);
    } else {
      setMessage(data.info);
      setText('');
      setTitle('');
      setFileName('');
      setFileText('');
      setAnalysis(null);
      load();
    }
  };

  const bookReady = type === 'book' && analysis !== null;

  return (
    <div className="page">
      <header>
        <h1>目标管理</h1>
        <a href="/">← 返回练习</a>
      </header>
      <NewAlgorithmGoalImport />
      <div className="layout">
        <div>
          <div className="card">
            <div className="badge">创建目标（材料 → 语块 → 学习队列）</div>
            <div style={{ margin: '12px 0' }}>
              {(['wordlist', 'book', 'ielts'] as GoalType[]).map((t) => (
                <button
                  key={t}
                  className={type === t ? 'primary' : ''}
                  onClick={() => {
                    setType(t);
                    setAnalysis(null);
                  }}
                >
                  {t === 'wordlist' ? '熟读词表' : t === 'book' ? '熟读一本书' : 'IELTS 目标分'}
                </button>
              ))}
            </div>

            <p className="muted">
              <input
                type="text"
                placeholder={
                  type === 'book' ? '书名，如 Moby Dick' : '目标名称，如：三月核心词表'
                }
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{ margin: 0 }}
              />
            </p>

            {type === 'wordlist' && (
              <>
                <p className="muted">
                  每行一个词/语块，可选带释义：
                  <span className="mono">resilient - 有韧性的</span>
                </p>
                <textarea
                  rows={8}
                  placeholder={'resilient - 有韧性的\noutcome - 结果\nstumble upon'}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </>
            )}

            {type === 'book' && (
              <>
                <p className="muted">
                  上传 <strong>.txt / .md / .pdf</strong>（文字版 PDF 直接提取，扫描版自动逐页
                  OCR），或粘贴小段文本。系统先分析词频/覆盖率，你确认后再导入。
                </p>
                <input
                  type="file"
                  accept=".txt,.md,.text,.pdf,text/plain,application/pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.name.toLowerCase().endsWith('.pdf')) uploadPdf(f);
                    else readFile(f);
                  }}
                />
                {fileName && <p className="pass">已载入：{fileName}</p>}
                {pdfJob && pdfJob.status === 'processing' && (
                  <p className="mono muted">
                    解析中… {pdfJob.processed_pages}/{pdfJob.total_pages || '?'} 页
                    {pdfJob.ocr_pages > 0 && `（已 OCR ${pdfJob.ocr_pages} 页）`}
                  </p>
                )}
                {pdfJob && pdfJob.status === 'error' && (
                  <p className="fail">解析失败：{pdfJob.error}</p>
                )}
                {!fileName && (
                  <>
                    <textarea
                      rows={6}
                      placeholder="Paste the book text here…"
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setAnalysis(null);
                      }}
                    />
                    <button className="ghost" onClick={() => setText(SAMPLE_TEXT)}>
                      没有文本？载入示例段落
                    </button>
                  </>
                )}
                <div style={{ margin: '12px 0' }}>
                  <button className="primary" onClick={analyze} disabled={analyzing}>
                    {analyzing ? '分析中…' : '① 分析词频与覆盖率'}
                  </button>
                </div>
              </>
            )}

            {type === 'ielts' && (
              <p className="muted">
                目标分数：
                <select value={score} onChange={(e) => setScore(e.target.value)}>
                  {['6.0', '6.5', '7.0', '7.5', '8.0'].map((s) => (
                    <option key={s} value={s}>
                      IELTS {s}
                    </option>
                  ))}
                </select>
                <br />
                系统会读取你的词汇量测量结果，把目标分对应的词频段材料转为练习。
              </p>
            )}

            {type !== 'book' && (
              <div style={{ marginTop: 12 }}>
                <button className="primary" onClick={submit}>
                  生成学习材料并入队
                </button>
              </div>
            )}
            {message && (
              <p className={message.startsWith('错误') ? 'fail' : 'pass'}>{message}</p>
            )}
          </div>

          {bookReady && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="badge">② 分析结果（{(analysis.durationMs / 1000).toFixed(1)}s）</div>
              <table>
                <tbody>
                  <tr>
                    <td>总词次</td>
                    <td>{analysis.totalTokens.toLocaleString()}</td>
                    <td>句子数</td>
                    <td>{analysis.totalSentences.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td>独立词</td>
                    <td>{analysis.uniqueWords.toLocaleString()}</td>
                    <td>内容词 / 专名</td>
                    <td>
                      {analysis.contentWords.toLocaleString()} / {analysis.properNouns.toLocaleString()}
                    </td>
                  </tr>
                  {analysis.knownCoverage != null && (
                    <tr>
                      <td>你的已知覆盖率</td>
                      <td colSpan={3}>
                        <strong className={analysis.knownCoverage >= 0.95 ? 'pass' : 'fail'}>
                          {pct(analysis.knownCoverage)}
                        </strong>
                        <span className="muted">
                          （≥95% 适合窄式阅读；低于 90% 建议先补词汇再读）
                        </span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="muted">
                覆盖率曲线：
                {analysis.coverageCurve
                  .map((c) => `前${c.top}词=${pct(c.ratio)}`)
                  .join(' · ')}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>词</th>
                    <th>频次</th>
                    <th>每百万</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.topWords.slice(0, 20).map((w, i) => (
                    <tr key={w.word}>
                      <td>{i + 1}</td>
                      <td>{w.word}</td>
                      <td>{w.count}</td>
                      <td>{w.perMillion}</td>
                      <td>{w.isProper && <span className="muted">专名·跳过</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">
                导入数量：
                <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {[20, 30, 50, 100, 200, 500, 1000].map((n) => (
                    <option key={n} value={n}>
                      {n} 词
                    </option>
                  ))}
                  <option value={0}>全部</option>
                </select>
                （按频次从高到低，自动跳过专名和已学过的词）
              </p>
              {count === 0 && (
                <p className="fail">
                  警告：全量导入会把数千个词一次性压入学习队列，其中约半数是全书只出现
                  1 次的低频词（学习价值低）。建议先小批次导入高频词，学完再导入下一批。
                </p>
              )}
              <button className="primary" onClick={submit}>
                ③ 导入为学习目标
              </button>
              {message && (
                <p className={message.startsWith('错误') ? 'fail' : 'pass'}>{message}</p>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>
            目标进度
          </div>
          {goals.length === 0 && <p className="muted">还没有目标，先创建一个。</p>}
          <table>
            <thead>
              <tr>
                <th>目标</th>
                <th>类型</th>
                <th>进度</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {goals.map((g) => (
                <Fragment key={g.id}>
                <tr key={g.id}>
                  <td>{g.title}</td>
                  <td>{TYPE_LABEL[g.type] ?? g.type}</td>
                  <td>
                    <span className={g.attainment >= 0.95 ? 'pass' : ''}>
                      达成 {pct(g.attainment)} · F̄ {g.fluency}
                    </span>
                    <br />
                    <span className="muted">
                      {g.target?.reading_wpm != null && `读 ${g.target.reading_wpm} wpm`}
                      {g.target?.reading_wpm != null && g.target?.writing_wpm != null && ' · '}
                      {g.target?.writing_wpm != null && `写 ${g.target.writing_wpm} wpm`}
                      {g.target?.vocab_size != null && ` · 词汇量 ${g.target.vocab_size}`}
                      <br />
                      毕业 {g.graduated} · 掌握 {g.mastered} · 待集成 {g.integrable} · 学习中{' '}
                      {g.inPipeline} · 未学 {g.fresh} / 共 {g.total}
                    </span>
                  </td>
                  <td>
                    <button
                      className="ghost"
                      onClick={() => glossGoalId === g.id ? setGlossGoalId(null) : loadGlossPage(g.id)}
                    >
                      释义管理{g.glossMissing > 0 ? `（缺 ${g.glossMissing}）` : ''}
                    </button>
                    <button className="ghost" onClick={() => removeGoal(g)}>
                      删除
                    </button>
                  </td>
                </tr>
                {glossGoalId === g.id && (
                  <tr key={`gloss-${g.id}`}>
                    <td colSpan={4}>
                      <div className="card" style={{ margin: '8px 0' }}>
                        <div className="muted">逐条确认释义。AI 结果只是建议；只有点击保存/采用建议后才会用于 R 学习。</div>
                        {glossWords.map((word) => (
                          <div key={word.id} style={{ borderTop: '1px solid #ddd', padding: '10px 0' }}>
                            <div><strong>{word.chunk}</strong></div>
                            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                              <input
                                aria-label={`${word.chunk} 释义`}
                                value={glossDrafts[word.id] ?? ''}
                                onChange={(event) => setGlossDrafts((current) => ({ ...current, [word.id]: event.target.value }))}
                                placeholder="手动添加释义"
                              />
                              <button className="primary" disabled={glossBusy === word.id} onClick={() => saveGloss(word.id)}>
                                保存
                              </button>
                              <button className="ghost" disabled={glossBusy === word.id} onClick={() => suggestGloss(word.id)}>
                                {glossBusy === word.id ? '处理中…' : 'AI 建议'}
                              </button>
                            </div>
                            {glossSuggestions[word.id] && (
                              <p className="muted">
                                AI 建议（尚未保存）：{glossSuggestions[word.id]}{' '}
                                <button className="ghost" disabled={glossBusy === word.id} onClick={() => saveGloss(word.id, glossSuggestions[word.id])}>
                                  采用并保存
                                </button>
                              </p>
                            )}
                          </div>
                        ))}
                        {glossMessage && <p className={glossMessage.startsWith('错误') ? 'fail' : 'pass'}>{glossMessage}</p>}
                        <button className="ghost" disabled={glossOffset <= 0} onClick={() => loadGlossPage(g.id, Math.max(0, glossOffset - GLOSS_PAGE_SIZE))}>上一页</button>
                        <span className="muted"> {glossTotal === 0 ? 0 : glossOffset + 1}–{Math.min(glossOffset + glossWords.length, glossTotal)} / {glossTotal} </span>
                        <button className="ghost" disabled={glossOffset + GLOSS_PAGE_SIZE >= glossTotal} onClick={() => loadGlossPage(g.id, glossOffset + GLOSS_PAGE_SIZE)}>下一页</button>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
