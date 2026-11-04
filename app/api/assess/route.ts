import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sampleTest, score } from '@/lib/assessment';
import { BANDS } from '@/lib/vocab-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ items: sampleTest() });
}

export async function POST(req: Request) {
  const db = getDb();
  const { answers } = (await req.json()) as {
    answers: { word: string; known: boolean }[];
  };
  const result = score(answers);
  db.prepare(
    `INSERT INTO assessments (ts, raw, estimate, nonwords_claimed, detail) VALUES (?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    result.raw,
    result.estimate,
    result.nonwordsClaimed,
    JSON.stringify({ bandDetail: result.bandDetail, answers })
  );
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('vocab_estimate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(result.estimate));
  // 逐词记录测量结果：导入目标时已知词高位播种（F_R=60 快速验证），不再让用户重学简单词
  const insertKnown = db.prepare(
    `INSERT INTO known_words (word, band, ts) VALUES (?, ?, ?)
     ON CONFLICT(word) DO UPDATE SET band = excluded.band, ts = excluded.ts`
  );
  const bandOfWord = new Map<string, number>();
  for (const b of BANDS) for (const w of b.words) bandOfWord.set(w, b.band);
  const now = Date.now();
  for (const a of answers) {
    if (a.known && bandOfWord.has(a.word)) insertKnown.run(a.word, bandOfWord.get(a.word), now);
  }
  return NextResponse.json(result);
}
