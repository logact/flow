import { NextResponse } from 'next/server';
import { updateLearnerSettingsUseCase } from '@/lib/application/learner-settings';
import { ConcurrencyConflictError } from '@/lib/application/repository';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 演示学习者档案与当前词汇估计。 */
export async function GET() {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const state = runtime.repository.load().state;
  return NextResponse.json({
    learner,
    llmConfigured: runtime.llmConfigured,
    counts: {
      materials: state.materials.length,
      goals: state.goals.length,
      tasks: state.tasks.length,
      attempts: state.attempts.length,
    },
  });
}

/** 更新学习设置（每日容量、时区）。 */
export async function PUT(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => ({}))) as {
    dailyTaskCapacity?: number;
    timezone?: string;
  };
  try {
    const updated = updateLearnerSettingsUseCase(runtime.repository, {
      learnerId: learner.id,
      dailyTaskCapacity: body.dailyTaskCapacity,
      timezone: body.timezone,
      now: new Date().toISOString(),
    });
    return NextResponse.json({ learner: updated });
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) {
      return NextResponse.json({ reason: 'concurrency_conflict' }, { status: 409 });
    }
    return NextResponse.json(
      { reason: 'invalid_input', message: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
