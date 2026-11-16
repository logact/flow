import { NextResponse } from 'next/server';
import { buildKnowledgePointLearningHistory } from '@/lib/application/knowledge-history';
import { knowledgePointName } from '@/lib/domain/functions';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = getRuntime();
  await runtime.ready;
  const state = runtime.repository.load().state;
  const point = state.knowledgePoints.find((item) => item.id === id);
  if (!point) return NextResponse.json({ reason: 'knowledge_point_not_found' }, { status: 404 });
  const learner = state.learners[0];
  const learning = state.learnerKnowledgePoints.find((item) => item.knowledgePointId === id && item.learnerId === learner?.id);
  const { history, timeline } = buildKnowledgePointLearningHistory(state.tasks, state.attempts, id);
  const future = learning
    ? (['R', 'P'] as const).filter((axis) => !learning.dimensions[axis].review.graduated)
      .map((axis) => ({ axis, dueAt: learning.dimensions[axis].review.dueAt, intervalDays: learning.dimensions[axis].review.intervalDays }))
    : [];
  const materialIds = [...new Set(state.materialAnalyses
    .filter((analysis) => analysis.items.some((item) => item.knowledgePoint.id === id))
    .map((analysis) => analysis.materialId))];
  return NextResponse.json({
    item: {
      id,
      name: knowledgePointName(point),
      definition: point.sense.definition,
      wordFamily: point.kind === 'word' || point.kind === 'phrase' ? point.wordFamily : null,
      pronunciation: point.pronunciation ?? null,
      pronunciationSupported: point.kind === 'word' || point.kind === 'phrase',
    },
    learning: learning ? { R: learning.dimensions.R, P: learning.dimensions.P } : null,
    future,
    history,
    timeline,
    materials: materialIds.map((materialId) => {
      const material = state.materials.find((item) => item.id === materialId);
      return material ? { id: material.id, title: material.title } : null;
    }).filter(Boolean),
  });
}
