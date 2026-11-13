import { NextResponse } from 'next/server';
import { refreshDailyPlanUseCase } from '@/lib/application/refresh-daily-plan';
import { localDateFor } from '@/lib/domain/functions';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 刷新并返回今日学习计划（R1：S07 排期 → S08 生成 → S09 落库）。 */
export async function GET() {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const now = new Date().toISOString();
  const date = localDateFor(now, learner.timezone);

  const result = await refreshDailyPlanUseCase(
    {
      repository: runtime.repository,
      taskRepository: runtime.repository,
      aiProvider: runtime.taskGenerationProvider,
    },
    { learnerId: learner.id, date, now },
  );

  if (!result.ok) {
    return NextResponse.json({ reason: result.reason, date }, { status: 502 });
  }
  return NextResponse.json({
    date,
    plan: { id: result.plan.id, taskCapacity: result.plan.taskCapacity },
    tasks: result.tasks,
  });
}
