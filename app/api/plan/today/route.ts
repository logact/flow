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
  const state = runtime.repository.load().state;
  const tasks = result.tasks.map((task) => {
    const sourceTask = state.tasks.find((item) => item.id === task.id);
    const pointId = sourceTask?.content.wordId;
    const candidate = pointId ? state.goalKnowledgePoints.find((item) => item.goalId === task.goalId && item.knowledgePointId === pointId) : undefined;
    const sourceIds = candidate ? state.goalKnowledgePointSources.filter((source) => source.goalId === task.goalId && source.knowledgePointId === candidate.knowledgePointId).map((source) => source.sourceAnalysisId) : [];
    const sources = sourceIds.map((analysisId) => { const analysis = state.materialAnalyses.find((item) => item.id === analysisId); const material = analysis && state.materials.find((item) => item.id === analysis.materialId); return material ? {id: material.id, title: material.title} : null; }).filter((item): item is {id:string;title:string} => Boolean(item));
    return {...task, sources};
  });
  return NextResponse.json({
    date,
    plan: { id: result.plan.id, taskCapacity: result.plan.taskCapacity },
    tasks,
  });
}
