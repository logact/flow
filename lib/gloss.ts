import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// 语块释义补全：本地词典（data/gloss-zh.tsv，ECDICT 高频子集）优先，
// 查不到（短语、生僻词）再回退在线源（MyMemory 中英 → dictionaryapi 英英）。
// 在线结果落 glosses 表缓存；查不到留空，UI 已有 chunk 兜底。

const TIMEOUT_MS = 5000;
const CONCURRENCY = 4;

let localDict: Map<string, string> | null = null;
let rankList: string[] | null = null;

// 频率序词表（data/word-rank.txt，行号即排名）：vocab_estimate → top-N 假定已知的底座
export function rankedWords(): string[] {
  if (!rankList) {
    try {
      rankList = fs
        .readFileSync(path.join(process.cwd(), 'data', 'word-rank.txt'), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      rankList = []; // 词表缺失时退化为无「假定已知」（node scripts/build-gloss.mjs 可重建）
    }
  }
  return rankList;
}

// 假定已知词集：词频表前 vocabEstimate 词 ∪ 测量确认词 ∪ 已学词 token
export function presumedKnown(
  db: Database.Database,
  vocabEstimate: number | null,
  attemptedTokens: Set<string>
): Set<string> {
  const known = new Set(attemptedTokens);
  if (vocabEstimate != null && vocabEstimate > 0) {
    for (const w of rankedWords().slice(0, Math.round(vocabEstimate))) known.add(w);
  }
  for (const r of db.prepare(`SELECT word FROM known_words`).all() as { word: string }[]) {
    known.add(r.word);
  }
  return known;
}

function localGlosses(): Map<string, string> {
  if (!localDict) {
    localDict = new Map();
    try {
      const text = fs.readFileSync(path.join(process.cwd(), 'data', 'gloss-zh.tsv'), 'utf8');
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf('\t');
        if (i > 0) localDict.set(line.slice(0, i), line.slice(i + 1));
      }
    } catch {
      /* 词典文件缺失时退化为纯在线（node scripts/build-gloss.mjs 可重建） */
    }
  }
  return localDict;
}

// 本地查词：精确命中 → 词形回退（与 book.ts 同款的保守后缀规则，命中词典才算）
export function lookupLocal(q: string): string | null {
  const d = localGlosses();
  const exact = d.get(q);
  if (exact) return exact;
  const cands: string[] = [];
  if (q.endsWith('ies')) cands.push(q.slice(0, -3) + 'y');
  if (q.endsWith('ing')) cands.push(q.slice(0, -3), q.slice(0, -3) + 'e');
  if (q.endsWith('ed')) cands.push(q.slice(0, -2), q.slice(0, -1), q.slice(0, -2) + 'e');
  if (q.endsWith('es')) cands.push(q.slice(0, -2));
  if (q.endsWith('s') && !q.endsWith('ss')) cands.push(q.slice(0, -1));
  for (const c of cands) {
    const g = c.length >= 3 ? d.get(c) : undefined;
    if (g) return g;
  }
  return null;
}

// 兼容热更新：运行中的进程不会重跑 db init，用前确保缓存表存在
function ensureTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS glosses (
    word TEXT PRIMARY KEY,
    meaning TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

const isBadGloss = (q: string, t: string) =>
  !t ||
  t.toLowerCase() === q.toLowerCase() ||
  /MYMEMORY|QUERY LENGTH|INVALID|NO QUERY/i.test(t);

// 机翻结果清理：去拼音注音（"[zu2]"）、合并相邻重复段（"卒 卒" → "卒"）
const cleanGloss = (t: string) => {
  const parts = t
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  return parts.filter((p, i) => i === 0 || p !== parts[i - 1]).join(' ');
};

async function fetchGloss(q: string): Promise<{ meaning: string; source: string } | null> {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|zh-CN`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    const j = (await res.json()) as {
      responseStatus?: number | string;
      responseData?: { translatedText?: string };
    };
    const t = cleanGloss(j.responseData?.translatedText ?? '');
    if (String(j.responseStatus) === '200' && !isBadGloss(q, t)) {
      return { meaning: t, source: 'mymemory' };
    }
  } catch {
    /* 网络失败走兜底 */
  }
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      meanings?: { partOfSpeech?: string; definitions?: { definition?: string }[] }[];
    }[];
    const m = j?.[0]?.meanings?.[0];
    const def = m?.definitions?.[0]?.definition;
    if (def) return { meaning: `(${m?.partOfSpeech ?? '?'}) ${def}`, source: 'dictionaryapi' };
  } catch {
    /* 查不到就留空 */
  }
  return null;
}

// 批量查词：本地词典（质量最高）→ 缓存表（既往在线结果）→ 在线源（并发限速，写回缓存）。
// 返回 lowercase(chunk) → meaning 的映射（只含查到的）。
export async function lookupGlosses(
  db: Database.Database,
  chunks: string[]
): Promise<Map<string, string>> {
  const keys = [...new Set(chunks.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  const found = new Map<string, string>();
  if (keys.length === 0) return found;
  ensureTable(db);

  // 本地词典：零延迟零网络，覆盖绝大多数书源词；优先于缓存——
  // 早期在线机翻的低质量缓存会被本地释义自然顶替（重建目标时生效）
  for (const k of keys) {
    const g = lookupLocal(k);
    if (g) found.set(k, g);
  }

  const remaining = keys.filter((k) => !found.has(k));
  if (remaining.length > 0) {
    const cached = db
      .prepare(
        `SELECT word, meaning FROM glosses WHERE word IN (${remaining.map(() => '?').join(',')})`
      )
      .all(...remaining) as { word: string; meaning: string }[];
    for (const r of cached) found.set(r.word, r.meaning);
  }

  const missing = keys.filter((k) => !found.has(k));
  const insert = db.prepare(
    `INSERT INTO glosses (word, meaning, source, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(word) DO UPDATE SET meaning = excluded.meaning, source = excluded.source, updated_at = excluded.updated_at`
  );
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchGloss));
    results.forEach((r, j) => {
      if (!r) return;
      found.set(batch[j], r.meaning);
      insert.run(batch[j], r.meaning, r.source, Date.now());
    });
  }
  return found;
}
