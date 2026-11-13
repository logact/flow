import { NextResponse } from 'next/server';
import { addMaterialToGoalUseCase } from '@/lib/application/goal-material';
import type { FluencyScores } from '@/lib/domain/model';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 目标列表：含候选知识点统计与材料关联数。 */
export async function GET() {
  const runtime = getRuntime();
  await runtime.ready;
  const state = runtime.repository.load().state;
  const goals = state.goals.map((goal) => {
    const candidates = state.goalKnowledgePoints.filter((item) => item.goalId === goal.id);
    return {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      targetFluency: goal.targetFluency,
      candidateCount: candidates.length,
      includedCount: candidates.filter((item) => item.selection === 'included').length,
      materialCount: state.goalMaterials.filter((link) => link.goalId === goal.id).length,
    };
  });
  return NextResponse.json({ goals });
}

/** 创建目标并加入已分析材料（S05）；goalId 传已有目标时改为向该目标追加材料。 */
export async function POST(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => null)) as {
    goalId?: string;
    title?: string;
    targetFluency?: FluencyScores;
    materialId?: string;
    analysisId?: string;
  } | null;
  if (!body?.materialId || !body.analysisId) {
    return NextResponse.json(
      { reason: 'invalid_input', message: '需要 materialId 与 analysisId' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const result = await addMaterialToGoalUseCase(
    { repository: runtime.repository },
    {
      goalId: body.goalId?.trim() || crypto.randomUUID(),
      learnerId: learner.id,
      title: body.title?.trim() || undefined,
      targetFluency: body.targetFluency,
      materialId: body.materialId,
      analysisId: body.analysisId,
      addedAt: now,
      now,
    },
  );

  if (!result.ok) {
    const status = result.reason === 'learner_not_found' ? 404 : 400;
    return NextResponse.json({ reason: result.reason }, { status });
  }
  return NextResponse.json({
    goal: { id: result.goal.id, title: result.goal.title, status: result.goal.status },
    candidateCount: result.candidates.length,
    knowledgePointCount: result.knowledgePoints.length,
  });
}
