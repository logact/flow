import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { applyResult, getNextTask, snapshot, type ResultInput } from '@/lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const db = getDb();
  const input = (await req.json()) as ResultInput;
  applyResult(db, input);
  return NextResponse.json({ task: getNextTask(db), ...snapshot(db) });
}
