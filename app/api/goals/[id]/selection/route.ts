import { NextResponse } from 'next/server';
import { selectKnowledgePointsUseCase } from '@/lib/application/knowledge-point-selection';
import type { GoalKnowledgePointSelection } from '@/lib/domain/model';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 设置候选知识点选择并初始化新增学习项（S06）。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const runtime = getRuntime();
  await runtime.ready;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    selections?: Array<{ knowledgePointId: string; selection: GoalKnowledgePointSelection }>;
  } | null;
  if (!body?.selections?.length) {
    return NextResponse.json({ reason: 'invalid_input', message: '需要非空 selections' }, { status: 400 });
  }

  const result = await selectKnowledgePointsUseCase(
    { repository: runtime.repository, vocabularyIndex: runtime.vocabularyIndex },
    {
      goalId: id,
      selections: body.selections,
      policyVersion: 'v1',
      now: new Date().toISOString(),
    },
  );

  if (!result.ok) {
    const status = result.reason === 'goal_not_found' ? 404 : 400;
    return NextResponse.json({ reason: result.reason }, { status });
  }
  return NextResponse.json({
    updatedCount: result.candidates.length,
    initialized: result.initialized.map((item) => ({
      knowledgePointId: item.knowledgePointId,
      initialFluency: item.initialFluency,
    })),
  });
}
