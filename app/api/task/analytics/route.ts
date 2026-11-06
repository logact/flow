import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getTaskAnalytics } from '@/lib/task-analytics';
import { recordTaskExit } from '../service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const db = getDb();
  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get('since');
  const untilRaw = url.searchParams.get('until');
  const since = sinceRaw == null ? undefined : Number(sinceRaw);
  const until = untilRaw == null ? undefined : Number(untilRaw);
  if ((since != null && !Number.isFinite(since)) || (until != null && !Number.isFinite(until))) {
    return NextResponse.json({ error: 'since/until must be timestamps in milliseconds' }, { status: 400 });
  }
  return NextResponse.json(getTaskAnalytics(db, { since, until }));
}

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (
    input == null || typeof input !== 'object' || Array.isArray(input) ||
    (input as { event_type?: unknown }).event_type !== 'task_exit' ||
    typeof (input as { instance_id?: unknown }).instance_id !== 'string'
  ) return NextResponse.json({ error: 'only task_exit telemetry is accepted' }, { status: 400 });

  const inserted = recordTaskExit(getDb(), (input as { instance_id: string }).instance_id);
  return NextResponse.json({ recorded: inserted });
}
