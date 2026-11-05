import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { submitTaskResult, TaskApiError, taskSnapshot } from '../service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const db = getDb();
  try {
    const input: unknown = await req.json();
    const result = submitTaskResult(db, input);
    return NextResponse.json({ ...result, ...taskSnapshot(db) });
  } catch (error) {
    if (error instanceof TaskApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    throw error;
  }
}
