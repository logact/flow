import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { persistBookAnalysis } from '@/lib/book-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const db = getDb();
  const id = new URL(req.url).searchParams.get('id');
  if (id) {
    // 单个书源的完整摘要（摘要 JSON 在分析时已存，topWords 从 book_words 实时查）
    const source = db.prepare('SELECT * FROM book_sources WHERE id = ?').get(Number(id)) as
      | { id: number; title: string; summary: string | null }
      | undefined;
    if (!source) return NextResponse.json({ error: '书源不存在' }, { status: 404 });
    const topWords = db
      .prepare(
        `SELECT word, freq AS count, per_million AS perMillion, is_proper AS isProper
         FROM book_words WHERE source_id = ? ORDER BY freq DESC LIMIT 50`
      )
      .all(source.id);
    return NextResponse.json({
      sourceId: source.id,
      durationMs: 0,
      ...(source.summary ? JSON.parse(source.summary) : {}),
      topWords,
    });
  }
  const sources = db
    .prepare(
      `SELECT s.id, s.title, s.total_tokens, s.total_sentences, s.created_at,
              SUM(CASE WHEN w.is_proper = 0 THEN 1 ELSE 0 END) AS content_words,
              SUM(CASE WHEN w.is_proper = 1 THEN 1 ELSE 0 END) AS proper_nouns
       FROM book_sources s
       LEFT JOIN book_words w ON w.source_id = s.id
       GROUP BY s.id
       ORDER BY s.id DESC`
    )
    .all();
  return NextResponse.json({ sources });
}

export async function POST(req: Request) {
  const db = getDb();
  let title = '未命名书籍';
  let text = '';

  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await req.json()) as { title?: string; text?: string };
    title = body.title?.trim() || title;
    text = body.text ?? '';
  } else {
    text = await req.text();
    title = new URL(req.url).searchParams.get('title') ?? title;
  }

  if (text.trim().length < 100) {
    return NextResponse.json({ error: '文本太短（< 100 字符），不像一本书' }, { status: 400 });
  }

  const result = persistBookAnalysis(db, title, text);
  return NextResponse.json(result);
}
