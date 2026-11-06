import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createGoal, deleteGoal, listGoalWords, listGoals, saveWordGloss, suggestWordGloss, type GoalInput } from '@/lib/goals';
import { LlmError } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const db = getDb();
  const url = new URL(req.url);
  const wordsGoal = url.searchParams.get('words');
  if (wordsGoal != null) {
    const goalId = Number(wordsGoal);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    try {
      return NextResponse.json(listGoalWords(db, goalId, offset, limit));
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 });
    }
  }
  return NextResponse.json({ goals: listGoals(db) });
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
    const input = await req.json() as GoalInput & { action?: string; wordId?: number };
    if (input.action === 'suggest_gloss') {
      if (!Number.isSafeInteger(input.wordId) || (input.wordId ?? 0) <= 0) {
        return NextResponse.json({ error: '无效的词条 id' }, { status: 400 });
      }
      return NextResponse.json({ suggestion: await suggestWordGloss(db, input.wordId!) });
    }
    if (!input.title?.trim()) throw new Error('目标名称不能为空');
    if (!['wordlist', 'book', 'ielts'].includes(input.type)) throw new Error('未知目标类型');
    const result = await createGoal(db, input);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof LlmError) {
      return NextResponse.json({ error: 'AI 释义暂不可用，请稍后重试' }, { status: 503 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const input: unknown = await req.json();
    if (!input || typeof input !== 'object' || !('wordId' in input) || !('meaning' in input) ||
        !Number.isSafeInteger(input.wordId) || typeof input.meaning !== 'string') {
      return NextResponse.json({ error: '词条释义请求无效' }, { status: 400 });
    }
    if (!saveWordGloss(getDb(), input.wordId as number, input.meaning)) {
      return NextResponse.json({ error: '词条不存在' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, meaning: input.meaning.trim() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
