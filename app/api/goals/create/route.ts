import { NextResponse } from 'next/server';
import type { FluencyScores, GoalKnowledgePointSelection } from '@/lib/domain/model';
import { createGoalFromMaterialsUseCase } from '@/lib/application/create-goal-from-materials';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 创建目标的 S05/S06 编排入口，支持多材料并以稳定 goalId 安全重试。 */
export async function POST(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => null)) as {
    goalId?: string;
    title?: string;
    targetFluency?: FluencyScores;
    materials?: Array<{ materialId: string; analysisId: string }>;
    selections?: Array<{ knowledgePointId: string; selection: GoalKnowledgePointSelection }>;
  } | null;
  if (!body || typeof body.goalId !== 'string' || !body.goalId.trim()
    || typeof body.title !== 'string' || !body.title.trim()
    || !body.targetFluency || !Array.isArray(body.materials)
    || !Array.isArray(body.selections)) {
    return NextResponse.json({ reason: 'invalid_input' }, { status: 400 });
  }

  const result = await createGoalFromMaterialsUseCase(
    { repository: runtime.repository, vocabularyIndex: runtime.vocabularyIndex },
    {
      goalId: body.goalId.trim(),
      learnerId: learner.id,
      title: body.title.trim(),
      targetFluency: body.targetFluency,
      materials: body.materials,
      selections: body.selections,
      now: new Date().toISOString(),
    },
  );
  if (!result.ok) {
    const status = result.reason === 'learner_not_found' ? 404 : 400;
    return NextResponse.json({ reason: result.reason }, { status });
  }
  return NextResponse.json({
    goal: result.goal,
    candidateCount: result.candidateCount,
    initializedCount: result.initializedCount,
  });
}
