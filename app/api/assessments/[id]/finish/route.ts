import { NextResponse } from 'next/server';
import { completeVocabularyAssessment, estimateVocabulary } from '@/lib/domain/functions';
import { ConcurrencyConflictError } from '@/lib/application/repository';
import type { VocabularyAssessment, VocabularyEstimate } from '@/lib/domain/model';
import { BNC_COCA_L6, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** Settle an assessment using only tasks the learner has answered so far. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const runtime = getRuntime();
  await runtime.ready;
  const { id } = await params;
  const snapshot = runtime.repository.load();
  const assessment = snapshot.state.vocabularyAssessments.find((item) => item.id === id);
  if (!assessment) return NextResponse.json({ reason: 'assessment_not_found' }, { status: 404 });
  if (assessment.status === 'completed') return NextResponse.json({ status: 'completed', result: assessment.result });
  if (assessment.status !== 'in_progress') return NextResponse.json({ reason: 'assessment_not_in_progress' }, { status: 409 });
  const learner = snapshot.state.learners.find((item) => item.id === assessment.learnerId);
  if (!learner) return NextResponse.json({ reason: 'assessment_not_found' }, { status: 404 });

  const attempts = snapshot.state.vocabularyAssessmentAttempts.filter((item) => item.assessmentId === id);
  const answeredIds = assessment.taskIds.filter((taskId) => attempts.some((attempt) => attempt.taskId === taskId));
  const tasks = answeredIds.map((taskId) => snapshot.state.vocabularyAssessmentTasks.find((item) => item.id === taskId)).filter((task): task is NonNullable<typeof task> => Boolean(task));
  const now = new Date().toISOString();
  let completedAssessment: Extract<VocabularyAssessment, { status: 'completed' }>;
  let updatedLearner = learner;
  if (!tasks.length) {
    const result = estimateVocabulary({ list: BNC_COCA_L6, bands: [], estimatedAt: now });
    completedAssessment = { ...assessment, taskIds: [], status: 'completed', result, completedAt: now };
    updatedLearner = { ...learner, currentVocabulary: result, updatedAt: now };
  } else {
    const result = completeVocabularyAssessment({
      learner,
      assessment: { ...assessment, taskIds: answeredIds },
      tasks,
      attempts,
      list: BNC_COCA_L6,
      bandWordFamilyCounts: await runtime.vocabularyListRepository.loadBandWordFamilyCounts(BNC_COCA_L6),
      now,
    });
    completedAssessment = { ...result.assessment, taskIds: answeredIds };
    updatedLearner = result.learner;
  }
  let saved;
  try {
    saved = runtime.repository.save({
      ...snapshot.state,
      learners: snapshot.state.learners.map((item) => item.id === learner.id ? updatedLearner : item),
      vocabularyAssessments: snapshot.state.vocabularyAssessments.map((item) => item.id === id ? completedAssessment : item),
    }, snapshot.revision);
  } catch (error) {
    if (!(error instanceof ConcurrencyConflictError)) throw error;
    const current = runtime.repository.load().state.vocabularyAssessments.find((item) => item.id === id);
    if (current?.status === 'completed') return NextResponse.json({ status: 'completed', result: current.result });
    return NextResponse.json({ reason: 'concurrency_conflict' }, { status: 409 });
  }
  const estimate: VocabularyEstimate = saved.state.vocabularyAssessments.find((item) => item.id === id)!.result!;
  return NextResponse.json({ status: 'completed', result: estimate, answered: answeredIds.length, total: answeredIds.length, early: true });
}
