import { NextResponse } from 'next/server';
import { startVocabularyAssessmentUseCase } from '@/lib/application/vocabulary-assessment';
import { toLearnerVocabularyAssessmentTask } from '@/lib/domain/functions';
import type { LearningState, VocabularyBand } from '@/lib/domain/model';
import { BNC_COCA_L6, getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

function assessmentView(state: LearningState, learnerId: string) {
  const assessment = [...state.vocabularyAssessments].reverse().find((item) => item.learnerId === learnerId && item.status === 'in_progress');
  if (!assessment) return null;
  const tasks = assessment.taskIds.map((id) => state.vocabularyAssessmentTasks.find((task) => task.id === id)).filter((task): task is NonNullable<typeof task> => Boolean(task));
  const attempts = state.vocabularyAssessmentAttempts.filter((attempt) => attempt.assessmentId === assessment.id);
  const cursor = tasks.findIndex((task) => !attempts.some((attempt) => attempt.taskId === task.id));
  const currentTask = tasks[cursor < 0 ? Math.max(0, tasks.length - 1) : cursor];
  return {
    assessmentId: assessment.id,
    tasks: tasks.map(toLearnerVocabularyAssessmentTask),
    cursor: cursor < 0 ? tasks.length : cursor,
    answered: attempts.length,
    total: tasks.length,
    currentBand: currentTask?.band ?? null,
    bandAnswered: currentTask ? tasks.filter((task) => task.band === currentTask.band && attempts.some((attempt) => attempt.taskId === task.id)).length : 0,
    bandTotal: currentTask ? tasks.filter((task) => task.band === currentTask.band).length : 0,
  };
}

/** Resume the learner's open assessment after refresh. */
export async function GET() {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const view = assessmentView(runtime.repository.load().state, learner.id);
  return NextResponse.json({ assessment: view });
}

/** Start an adaptive assessment with six questions in the lowest frequency band. */
export async function POST() {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const state = runtime.repository.load().state;
  const active = assessmentView(state, learner.id);
  if (active) return NextResponse.json(active);

  const counts = await runtime.vocabularyListRepository.loadBandWordFamilyCounts(BNC_COCA_L6);
  const firstBand = Object.keys(counts).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))[0] as VocabularyBand | undefined;
  if (!firstBand) return NextResponse.json({ reason: 'vocabulary_list_unavailable' }, { status: 400 });
  const sampleCounts: Partial<Record<VocabularyBand, number>> = { [firstBand]: Math.min(6, counts[firstBand] ?? 0) };
  const total = sampleCounts[firstBand] ?? 0;
  if (!total) return NextResponse.json({ reason: 'vocabulary_list_unavailable' }, { status: 400 });
  const result = await startVocabularyAssessmentUseCase(
    { repository: runtime.repository, vocabularyListRepository: runtime.vocabularyListRepository },
    {
      learnerId: learner.id,
      list: BNC_COCA_L6,
      sampleCounts,
      seed: crypto.randomUUID(),
      assessmentId: crypto.randomUUID(),
      taskIds: Array.from({ length: total }, () => crypto.randomUUID()),
      now: new Date().toISOString(),
    },
  );
  if (!result.ok) return NextResponse.json({ reason: result.reason }, { status: 400 });
  return NextResponse.json(assessmentView(runtime.repository.load().state, learner.id));
}
