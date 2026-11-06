'use client';

type Change = {
  word_id: number;
  word: string;
  axis: 'p' | 'r';
  score_before: number;
  score_after: number;
  verified_before: number;
  verified_after: number;
  speed_verified_before: number;
  speed_verified_after: number;
};

type HistoryRow = {
  id: number;
  tick: number;
  ts: number;
  kind: string;
  result: string | null;
  change: Change | null;
};

type WordScore = { id: number; chunk: string; fluency: number; fluency_r: number };
type NewWord = { id: number; chunk: string; meaning: string; goal_title: string };

const columns = [
  '记录类型', '时间', 'Tick', '词条ID', '词语', '轴', '任务类型', '任务用途', '结果',
  '分数变化前', '分数变化后', '分数差值', '认证前', '认证后', '速度认证前', '速度认证后',
];

function csvCell(value: string | number | null) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv(words: WordScore[], history: HistoryRow[]) {
  const currentRows = words.map((word) => [
    '当前分数', new Date().toISOString(), '', word.id, word.chunk, 'R/P', '', '', '', '',
    `R=${word.fluency_r}; P=${word.fluency}`, '', '', '', '', '',
  ]);
  const eventRows = history.map((row) => {
    const [taskType = row.kind, purpose = ''] = row.kind.split(':');
    const change = row.change;
    return [
      '任务事件', new Date(row.ts).toISOString(), row.tick, change?.word_id ?? '', change?.word ?? '',
      change?.axis.toUpperCase() ?? '', taskType, purpose, row.result ?? '',
      change?.score_before ?? '历史缺失', change?.score_after ?? '历史缺失',
      change ? Number((change.score_after - change.score_before).toFixed(2)) : '历史缺失',
      change?.verified_before ?? '', change?.verified_after ?? '',
      change?.speed_verified_before ?? '', change?.speed_verified_after ?? '',
    ];
  });
  const content = [columns, ...currentRows, ...eventRows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `flow-score-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function displayTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

export default function ScoreHistoryView({ words, newWords, history }: { words: WordScore[]; newWords: NewWord[]; history: HistoryRow[] }) {
  return (
    <>
      <section style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 18, marginBottom: 22 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>新词 · {newWords.length} 个</h2>
        {newWords.length === 0 ? <p style={{ color: '#8b949e' }}>当前没有待学习的新词。</p> : (
          <div style={{ overflowX: 'auto' }}><table><thead><tr><th>ID</th><th>所属目标</th><th>词语</th><th>释义</th></tr></thead><tbody>
            {newWords.map((word) => <tr key={word.id}><td>{word.id}</td><td>{word.goal_title}</td><td>{word.chunk}</td><td>{word.meaning || '尚未添加释义'}</td></tr>)}
          </tbody></table></div>
        )}
      </section>
      <section style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 18, marginBottom: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>当前分数 · {words.length} 词</h2>
          <button type="button" onClick={() => exportCsv(words, history)} style={{ margin: 0 }}>导出清单 CSV</button>
        </div>
        <p style={{ color: '#8b949e', fontSize: 12 }}>导出文件包含当前词条分数和本页展示的最近 500 条事件，可附在手动测试记录中。</p>
        {words.length === 0 ? <p style={{ color: '#8b949e' }}>当前没有词语数据。</p> : (
          <div style={{ overflowX: 'auto' }}><table><thead><tr><th>ID</th><th>词语</th><th>R 阅读</th><th>P 产出</th></tr></thead><tbody>
            {words.map((word) => <tr key={word.id}><td>{word.id}</td><td>{word.chunk}</td><td>{word.fluency_r}</td><td>{word.fluency}</td></tr>)}
          </tbody></table></div>
        )}
      </section>

      <section style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 18 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>变化记录 · 最近 500 条事件</h2>
        {history.length === 0 ? <p style={{ color: '#8b949e' }}>还没有任务结算记录。完成一项真实任务后，这里会显示该任务的分数变化。</p> : (
          <div style={{ overflowX: 'auto' }}><table><thead><tr><th>时间</th><th>Tick</th><th>词语</th><th>轴</th><th>任务 / 用途</th><th>结果</th><th>分数</th><th>认证变化</th></tr></thead><tbody>
            {history.map((row, index) => <tr key={`${row.id}-${row.change?.word_id ?? 'legacy'}-${index}`}>
              <td>{displayTime(row.ts)}</td><td>{row.tick}</td><td>{row.change?.word ?? '—'}</td>
              <td>{row.change ? row.change.axis.toUpperCase() : '—'}</td><td>{row.kind}</td><td>{row.result ?? '—'}</td>
              <td>{row.change ? `${row.change.score_before} → ${row.change.score_after}` : '旧记录无前后分数'}</td>
              <td>{row.change ? `验证 ${row.change.verified_before}→${row.change.verified_after}；测速 ${row.change.speed_verified_before}→${row.change.speed_verified_after}` : '—'}</td>
            </tr>)}
          </tbody></table></div>
        )}
        <p style={{ color: '#8b949e', fontSize: 12, marginBottom: 0 }}>新记录保存每个相关词的分数前后值。旧事件缺少变化前分数，会在导出文件中标记为“历史缺失”。</p>
      </section>
    </>
  );
}
