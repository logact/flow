import { NextResponse } from 'next/server';
import { changeLearningGoalStatusUseCase } from '@/lib/application/goal-status';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 完成或归档学习目标（S12）。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const runtime = getRuntime();
  await runtime.ready;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { status?: string } | null;
  if (body?.status !== 'completed' && body?.status !== 'archived') {
    return NextResponse.json({ reason: 'invalid_input', message: "status 必须是 'completed' 或 'archived'" }, { status: 400 });
  }
  try {
    const goal = changeLearningGoalStatusUseCase(runtime.repository, {
      goalId: id,
      status: body.status,
      now: new Date().toISOString(),
    });
    return NextResponse.json({ goal: { id: goal.id, status: goal.status } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Learning goal not found:')) {
      return NextResponse.json({ reason: 'goal_not_found' }, { status: 404 });
    }
    return NextResponse.json({ reason: 'invalid_input', message }, { status: 400 });
  }
}
