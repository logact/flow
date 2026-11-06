import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { skipTask, TaskApiError } from '../service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let input: unknown;
  try { input = await request.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { instance_id?: unknown }).instance_id !== 'string') {
    return NextResponse.json({ error: 'instance_id is required' }, { status: 400 });
  }
  try {
    return NextResponse.json(await skipTask(getDb(), (input as { instance_id: string }).instance_id));
  } catch (error) {
    if (error instanceof TaskApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
