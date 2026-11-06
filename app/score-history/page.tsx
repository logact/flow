import { getDb } from '@/lib/db';
import ScoreHistoryView from './score-history-view';

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

function changesFromDetail(detail: string | null): Change[] {
  if (!detail) return [];
  try {
    const parsed = JSON.parse(detail) as { score_changes?: unknown };
    return Array.isArray(parsed.score_changes)
      ? parsed.score_changes.filter((item): item is Change =>
          item != null && typeof item === 'object' &&
          typeof (item as Change).word_id === 'number' &&
          typeof (item as Change).word === 'string' &&
          ((item as Change).axis === 'p' || (item as Change).axis === 'r') &&
          typeof (item as Change).score_before === 'number' &&
          typeof (item as Change).score_after === 'number')
      : [];
  } catch {
    return [];
  }
}

export const dynamic = 'force-dynamic';

export default function ScoreHistoryPage() {
  const db = getDb();
  const words = db.prepare(`SELECT id, chunk, fluency, fluency_r FROM words ORDER BY chunk COLLATE NOCASE`).all() as
    { id: number; chunk: string; fluency: number; fluency_r: number }[];
  const newWords = db.prepare(`
    SELECT words.id, words.chunk, words.meaning, COALESCE(goals.title, '未关联目标') AS goal_title
    FROM words LEFT JOIN goals ON goals.id = words.goal_id
    WHERE words.introduced = 0
    ORDER BY goals.title COLLATE NOCASE, words.chunk COLLATE NOCASE
  `).all() as { id: number; chunk: string; meaning: string; goal_title: string }[];
  const eventRows = db.prepare(`SELECT id, tick, ts, kind, result, detail FROM events ORDER BY ts DESC, id DESC LIMIT 500`).all() as
    { id: number; tick: number; ts: number; kind: string; result: string | null; detail: string | null }[];
  const history: HistoryRow[] = eventRows.flatMap((event) => {
    const changes = changesFromDetail(event.detail);
    if (changes.length) return changes.map((change) => ({ ...event, change }));
    // Events written before score snapshots were added remain visible, with their missing evidence explicit.
    if (event.kind.includes(':')) return [{ ...event, change: null }];
    return [];
  });

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 18px 64px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <div><h1 style={{ margin: 0 }}>词语分数变化</h1><p style={{ color: '#8b949e', margin: '6px 0 0' }}>查看当前 R / P 分数，以及每次任务结算留下的分数变化记录。</p></div>
        <a href="/" style={{ color: '#58a6ff' }}>返回练习</a>
      </header>

      <ScoreHistoryView words={words} newWords={newWords} history={history} />
    </main>
  );
}
