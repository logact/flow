import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const db = getDb();
  const id = new URL(req.url).searchParams.get('id');
  if (id) {
    const job = db.prepare('SELECT * FROM book_jobs WHERE id = ?').get(Number(id));
    return job
      ? NextResponse.json({ job })
      : NextResponse.json({ error: '任务不存在' }, { status: 404 });
  }
  const jobs = db.prepare('SELECT * FROM book_jobs ORDER BY id DESC LIMIT 20').all();
  return NextResponse.json({ jobs });
}
