'use client';

import { useState } from 'react';

type Item = { word: string };

type Result = {
  raw: number;
  estimate: number;
  nonwordsClaimed: number;
  label: string;
  ielts: string;
  bandDetail: { band: number; known: number; total: number }[];
};

export default function AssessPage() {
  const [stage, setStage] = useState<'intro' | 'test' | 'result'>('intro');
  const [items, setItems] = useState<Item[]>([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<{ word: string; known: boolean }[]>([]);
  const [result, setResult] = useState<Result | null>(null);

  const start = async () => {
    const res = await fetch('/api/assess', { cache: 'no-store' });
    const data = await res.json();
    setItems(data.items);
    setIdx(0);
    setAnswers([]);
    setStage('test');
  };

  const answer = async (known: boolean) => {
    const next = [...answers, { word: items[idx].word, known }];
    setAnswers(next);
    if (idx + 1 < items.length) {
      setIdx(idx + 1);
    } else {
      const res = await fetch('/api/assess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: next }),
      });
      setResult(await res.json());
      setStage('result');
    }
  };

  return (
    <div className="page">
      <header>
        <h1>词汇量测量</h1>
        <a href="/">← 返回练习</a>
      </header>

      {stage === 'intro' && (
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="badge">分层抽样法</div>
          <p>
            从 10 个词频段（1k~10k）各随机抽 4 个词，混入 3 个<strong>不存在的伪词</strong>防虚报。
            你只需要对每个词诚实地点「认识 / 不认识」，全程约 2 分钟。
          </p>
          <p className="muted">
            判定标准：看到词能立刻反应出至少一个核心含义才算「认识」，眼熟不算。
            结果是粗略估计（误差约 ±20%），用于目标选材的参考起点。
          </p>
          <button className="primary" onClick={start}>
            开始测量（43 个词）
          </button>
        </div>
      )}

      {stage === 'test' && (
        <div className="card" style={{ maxWidth: 560, textAlign: 'center' }}>
          <div className="muted">
            {idx + 1} / {items.length}
          </div>
          <div className="chunk" style={{ fontSize: 36, margin: '24px 0' }}>
            {items[idx].word}
          </div>
          <p className="muted">看到它能立刻反应出含义吗？</p>
          <button className="primary" onClick={() => answer(true)}>
            认识
          </button>
          <button className="danger" onClick={() => answer(false)}>
            不认识
          </button>
        </div>
      )}

      {stage === 'result' && result && (
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="badge">测量结果</div>
          <div className="chunk" style={{ fontSize: 40 }}>
            ≈ {result.estimate.toLocaleString()} 词
          </div>
          <p>
            等级：{result.label} ｜ 大致对应 IELTS {result.ielts}
          </p>
          {result.nonwordsClaimed > 0 && (
            <p className="fail">
              你声称认识 {result.nonwordsClaimed} 个伪词（不存在的词），估计值已按虚报倾向下调
              （原始值 {result.raw.toLocaleString()}）。下次诚实一点，测量才有意义。
            </p>
          )}
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>词频段</th>
                <th>命中率</th>
              </tr>
            </thead>
            <tbody>
              {result.bandDetail.map((b) => (
                <tr key={b.band}>
                  <td>{b.band / 1000}k</td>
                  <td>
                    {'█'.repeat(b.known)}
                    {'░'.repeat(b.total - b.known)} {b.known}/{b.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 12 }}>
            各段命中率 × 段容量（1000 词）求和得到总量。哪个段开始掉链子，就是你的学习起点。
          </p>
          <a href="/goals">
            <button className="primary">下一步：设定目标 →</button>
          </a>
          <button className="ghost" onClick={start}>
            重新测一次
          </button>
        </div>
      )}
    </div>
  );
}
