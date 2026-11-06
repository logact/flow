import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getOrIssueTask, TaskApiError } from './service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  try {
    return NextResponse.json(await getOrIssueTask(db));
  } catch (error) {
    if (error instanceof TaskApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
