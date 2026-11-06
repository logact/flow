'use client';

import { useState } from 'react';

const scenarios = [
  { id: 'encode', label: 'ENCODE：建立语义连接', word: 'deplete mental energy', note: '全新词条，先看释义、场景和例句。' },
  { id: 'retrieve-r', label: 'R RETRIEVE：释义识别', word: 'remove friction', note: 'R 轴 35 分，P 轴设为完成。' },
  { id: 'retrieve-p', label: 'P RETRIEVE：表达回忆', word: 'pay a hidden tax', note: 'P 轴 35 分，R 轴设为完成。' },
  { id: 'fluency-r', label: 'R FLUENCY：连续阅读', word: 'break the ice', note: 'R 轴 55 分，配有主题匹配篇章；出题需要 LLM 可用。' },
  { id: 'fluency-p', label: 'P FLUENCY：连续写作', word: 'build momentum', note: 'P 轴 55 分，写作材料超过 30 词。' },
  { id: 'missing-gloss', label: '缺少 gloss：手动补充 / AI 建议', word: 'offload decisions', note: '无释义新词；用于检查 AI 建议是否需确认保存。' },
  { id: 'retention-recovery', label: '遗忘后恢复：P 轴重测', word: 'reclaim your attention', note: 'P 轴时间戳预置为 60 天前，用于观察调度恢复路径。' },
] as const;

export default function ManualTestData() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState('');

  const prepare = async (scenario: string) => {
    setBusy(true);
    setMessage('正在重置隔离测试数据库并准备场景…');
    try {
      const response = await fetch('/api/manual-test-data', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '测试场景准备失败');
      setSelected(scenario);
      const count = typeof result.fixture?.wordCount === 'number' ? `共 ${result.fixture.wordCount} 个词条` : '';
      const words = Array.isArray(result.fixture?.words) ? `：${result.fixture.words.join('、')}` : '';
      setMessage(`场景已准备：${scenario}${count ? `（${count}${words}）` : ''}。打开学习页开始测试。`);
    } catch (error) {
      setMessage(`失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: '32px auto', padding: '0 20px', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ color: '#6b7280', fontSize: 13 }}>MANUAL QA / TEST DATA</p>
      <h1>手动测试场景</h1>
      <p>每次准备场景都会清空并重建 <code>.manual-test/flow.db</code>。日常使用的 <code>flow.db</code> 不会被修改；请先结束当前测试中的作答。</p>
      <p><a href="/">打开学习页 →</a></p>
      <button disabled={busy} onClick={() => void prepare('baseline')}>恢复基础数据（8 个 ENCODE 词条）</button>
      <div style={{ display: 'grid', gap: 12, marginTop: 24 }}>
        {scenarios.map((scenario) => (
          <section key={scenario.id} style={{ border: '1px solid #d1d5db', borderRadius: 10, padding: 16 }}>
            <h2 style={{ fontSize: 17, margin: '0 0 6px' }}>{scenario.label}</h2>
            <p style={{ margin: '0 0 8px', color: '#111827' }}>测试词条：<strong>{scenario.word}</strong></p>
            <p style={{ margin: '0 0 12px', color: '#4b5563' }}>{scenario.note}</p>
            <button disabled={busy} onClick={() => void prepare(scenario.id)}>
              {selected === scenario.id ? '重新准备此场景' : '准备场景'}
            </button>
          </section>
        ))}
      </div>
      <p style={{ marginTop: 20 }} role="status" aria-live="polite">{message}</p>
    </main>
  );
}
