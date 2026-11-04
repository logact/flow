import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getNextTask, snapshot } from '@/lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  return NextResponse.json({ task: getNextTask(db), ...snapshot(db) });
}
