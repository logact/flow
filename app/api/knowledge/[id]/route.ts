import { NextResponse } from 'next/server';
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
  const tasks = state.tasks.filter((task) => 'wordId' in task.content.content && task.content.content.wordId === id);
  const taskIds = new Set(tasks.map((task) => task.id));
  const attempts = state.attempts.filter((attempt) => taskIds.has(attempt.taskId))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const attemptsByTask = new Map(attempts.map((attempt) => [attempt.taskId, attempt]));
  const history: Array<{ id: string; date: string; status: string; taskType: string; hasSettlement: boolean; judgement: unknown }> = tasks.flatMap((task) => {
    const attempt = attemptsByTask.get(task.id);
    if (attempt) return [{
      id: attempt.id,
      date: attempt.receivedAt,
      status: attempt.status as string,
      taskType: task.content.task as string,
      hasSettlement: attempt.status === 'settled',
      judgement: attempt.status === 'settled' ? attempt.judgement : null,
    }];
    if (task.status === 'completed' && task.completedAt) return [{
      id: task.id,
      date: task.completedAt,
      status: 'completed',
      taskType: task.content.task as string,
      hasSettlement: false,
      judgement: null,
    }];
    return [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const timeline = attempts.flatMap((attempt) => attempt.status === 'settled'
    ? attempt.settlement.fluencyChanges.filter((change) => change.knowledgePointId === id)
      .map((change) => ({ date: attempt.receivedAt, dimension: change.dimension, before: change.before, after: change.after }))
    : []);
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
