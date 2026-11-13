import { NextResponse } from 'next/server';
import { knowledgePointName } from '@/lib/domain/functions';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 目标详情：候选知识点、学习者选择状态、当前流利度与词频段。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const runtime = getRuntime();
  await runtime.ready;
  const { id } = await params;
  const state = runtime.repository.load().state;
  const goal = state.goals.find((item) => item.id === id);
  if (!goal) {
    return NextResponse.json({ reason: 'goal_not_found' }, { status: 404 });
  }
  const candidates = state.goalKnowledgePoints
    .filter((item) => item.goalId === id)
    .map((candidate) => {
      const knowledgePoint = state.knowledgePoints.find((item) => item.id === candidate.knowledgePointId);
      const learning = state.learnerKnowledgePoints.find(
        (item) => item.knowledgePointId === candidate.knowledgePointId && item.learnerId === goal.learnerId,
      );
      const classification = state.knowledgePointVocabularyClassifications.find(
        (item) => item.knowledgePointId === candidate.knowledgePointId,
      );
      return {
        knowledgePointId: candidate.knowledgePointId,
        name: knowledgePoint ? knowledgePointName(knowledgePoint) : candidate.knowledgePointId,
        definition: knowledgePoint?.sense.definition ?? null,
        partOfSpeech: knowledgePoint?.sense.partOfSpeech ?? null,
        selection: candidate.selection,
        band: classification?.band ?? null,
        learning: learning
          ? {
              fluency: {
                R: learning.dimensions.R.fluency,
                P: learning.dimensions.P.fluency,
              },
              dueAt: {
                R: learning.dimensions.R.review.dueAt,
                P: learning.dimensions.P.review.dueAt,
              },
              graduated: {
                R: learning.dimensions.R.review.graduated,
                P: learning.dimensions.P.review.graduated,
              },
            }
          : null,
      };
    });
  const materials = state.goalMaterials
    .filter((link) => link.goalId === id)
    .map((link) => {
      const material = state.materials.find((item) => item.id === link.materialId);
      return { materialId: link.materialId, title: material?.title ?? link.materialId, analysisId: link.analysisId };
    });
  const learner = state.learners.find((item) => item.id === goal.learnerId);
  return NextResponse.json({
    goal: {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      targetFluency: goal.targetFluency,
    },
    assessmentCompleted: Boolean(learner?.currentVocabulary),
    materials,
    candidates,
  });
}
