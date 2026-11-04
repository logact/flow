import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueuePdfJob } from '@/lib/pdf-job';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// PDF 上传：落盘 → 创建任务行 → 后台串行队列处理 → 立即返回 jobId 供轮询
export async function POST(req: Request) {
  const db = getDb();
  const form = await req.formData();
  const file = form.get('file');
  const title = String(form.get('title') ?? '').trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: '只支持 PDF 文件' }, { status: 400 });
  }

  const now = Date.now();
  const jobId = Number(
    db
      .prepare(
        `INSERT INTO book_jobs (title, filename, created_at, updated_at) VALUES (?, ?, ?, ?)`
      )
      .run(title || file.name.replace(/\.pdf$/i, ''), file.name, now, now).lastInsertRowid
  );

  const dir = path.join(process.cwd(), '.data', 'uploads');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${jobId}.pdf`);
  writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));

  enqueuePdfJob(db, jobId, filePath, title || file.name.replace(/\.pdf$/i, ''));
  return NextResponse.json({ jobId });
}
