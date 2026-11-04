import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createGoal, deleteGoal, listGoals, type GoalInput } from '@/lib/goals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ goals: listGoals(getDb()) });
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '无效的目标 id' }, { status: 400 });
  }
  if (!deleteGoal(getDb(), id)) {
    return NextResponse.json({ error: '目标不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const db = getDb();
  try {
    const input = (await req.json()) as GoalInput;
    if (!input.title?.trim()) throw new Error('目标名称不能为空');
    if (!['wordlist', 'book', 'ielts'].includes(input.type)) throw new Error('未知目标类型');
    const result = await createGoal(db, input);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
