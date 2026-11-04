import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  getActiveGoalId,
  getGoalScopeStrict,
  setActiveGoalId,
  setGoalScopeStrict,
} from '@/lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  return NextResponse.json({
    activeGoalId: getActiveGoalId(db),
    goalScopeStrict: getGoalScopeStrict(db),
  });
}

export async function POST(req: Request) {
  const db = getDb();
  const { goalId, strict } = (await req.json()) as { goalId: number | null; strict?: boolean };
  if (goalId != null) {
    const goal = db.prepare('SELECT id FROM goals WHERE id = ?').get(goalId);
    if (!goal) return NextResponse.json({ error: '目标不存在' }, { status: 404 });
  }
  setActiveGoalId(db, goalId ?? null);
  if (strict !== undefined) setGoalScopeStrict(db, strict);
  return NextResponse.json({
    activeGoalId: goalId ?? null,
    goalScopeStrict: getGoalScopeStrict(db),
  });
}
