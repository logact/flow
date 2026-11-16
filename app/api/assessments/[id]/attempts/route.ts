import { NextResponse } from 'next/server';
import {
  completeVocabularyAssessment,
  decideAdaptiveVocabularyBand,
  generateVocabularyAssessmentTasks,
  recordVocabularyAssessmentAttempt,
  sampleVocabularyForAssessment,
  toLearnerVocabularyAssessmentTask,
} from '@/lib/domain/functions';
import { ConcurrencyConflictError } from '@/lib/application/repository';
import type { LearningState, VocabularyAssessment, VocabularyBand } from '@/lib/domain/model';
import { BNC_COCA_L6, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

function viewOf(state: LearningState, assessment: VocabularyAssessment) {
  const tasks = assessment.taskIds.map((taskId) => state.vocabularyAssessmentTasks.find((task) => task.id === taskId)).filter((task): task is NonNullable<typeof task> => Boolean(task));
  const attempts = state.vocabularyAssessmentAttempts.filter((attempt) => attempt.assessmentId === assessment.id);
  const cursor = tasks.findIndex((task) => !attempts.some((attempt) => attempt.taskId === task.id));
  const currentTask = tasks[cursor < 0 ? Math.max(tasks.length - 1, 0) : cursor];
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

function orderBands(bands: string[]): VocabularyBand[] {
  return bands.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)) as VocabularyBand[];
}

function familyId(task: { knowledgePoint: { id: string } }): string {
  return task.knowledgePoint.id.startsWith('assessment:') ? task.knowledgePoint.id.slice('assessment:'.length) : task.knowledgePoint.id;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const runtime = getRuntime();
  await runtime.ready;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { taskId?: string; known?: boolean; attemptId?: string } | null;
  if (!body?.taskId || typeof body.known !== 'boolean') return NextResponse.json({ reason: 'invalid_input' }, { status: 400 });

  const snapshot = runtime.repository.load();
  const assessment = snapshot.state.vocabularyAssessments.find((item) => item.id === id);
  if (!assessment) return NextResponse.json({ reason: 'assessment_not_found' }, { status: 404 });
  if (assessment.status === 'completed') return NextResponse.json({ status: 'completed', result: assessment.result });
  if (assessment.status !== 'in_progress') return NextResponse.json({ reason: 'assessment_not_in_progress' }, { status: 409 });
  const learner = snapshot.state.learners.find((item) => item.id === assessment.learnerId);
  const task = snapshot.state.vocabularyAssessmentTasks.find((item) => item.id === body.taskId && assessment.taskIds.includes(item.id));
  if (!learner) return NextResponse.json({ reason: 'assessment_not_found' }, { status: 404 });
  if (!task) return NextResponse.json({ reason: 'task_not_found' }, { status: 404 });

  const priorAttempts = snapshot.state.vocabularyAssessmentAttempts.filter((attempt) => attempt.assessmentId === id);
  const alreadyAnswered = priorAttempts.find((attempt) => attempt.taskId === task.id);
  if (alreadyAnswered) return NextResponse.json({ status: 'in_progress', ...viewOf(snapshot.state, assessment) });
  let attempt;
  try {
    attempt = recordVocabularyAssessmentAttempt({
      attemptId: body.attemptId?.trim() || crypto.randomUUID(), assessment, task,
      previousAttempts: priorAttempts, known: body.known, answeredAt: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ reason: 'invalid_input' }, { status: 400 });
  }

  const stateWithAttempt: LearningState = {
    ...snapshot.state,
    vocabularyAssessmentAttempts: [...snapshot.state.vocabularyAssessmentAttempts, attempt],
  };
  const answeredTasks = assessment.taskIds.filter((taskId) => stateWithAttempt.vocabularyAssessmentAttempts.some((record) => record.assessmentId === id && record.taskId === taskId));
  const pendingTasks = assessment.taskIds.filter((taskId) => !answeredTasks.includes(taskId));
  let updatedAssessment: VocabularyAssessment = assessment;
  let nextTasks = [] as ReturnType<typeof generateVocabularyAssessmentTasks>;
  let shouldComplete = false;

  if (pendingTasks.length === 0) {
    const bandTasks = assessment.taskIds.map((taskId) => stateWithAttempt.vocabularyAssessmentTasks.find((item) => item.id === taskId)).filter((item): item is NonNullable<typeof item> => Boolean(item && item.band === task.band));
    const bandAttempts = stateWithAttempt.vocabularyAssessmentAttempts.filter((item) => item.assessmentId === id && bandTasks.some((bandTask) => bandTask.id === item.taskId));
    const knownCount = bandAttempts.filter((item) => item.known).length;
    const bandDecision = [6, 10, 12].includes(bandTasks.length)
      ? decideAdaptiveVocabularyBand({ knownCount, sampleCount: bandTasks.length })
      : 'stop';
    const counts = await runtime.vocabularyListRepository.loadBandWordFamilyCounts(BNC_COCA_L6);
    const bands = orderBands(Object.keys(counts));
    const bandIndex = bands.indexOf(task.band);
    const highestBand = bandIndex < 0 || bandIndex === bands.length - 1;
    let targetBand: VocabularyBand | null = null;
    let targetCount = 0;
    if (bandDecision === 'append') {
      targetBand = task.band;
      targetCount = bandTasks.length === 6 ? 4 : 2;
    } else if (bandDecision === 'continue' && !highestBand) {
      targetBand = bands[bandIndex + 1];
      targetCount = 6;
    } else if (bandDecision === 'continue' && highestBand && bandTasks.length === 6) {
      targetBand = task.band;
      targetCount = 4;
    } else if (bandDecision === 'continue' && highestBand && bandTasks.length === 10) {
      targetBand = task.band;
      targetCount = 2;
    } else {
      shouldComplete = true;
    }

    if (targetBand) {
      const families = await runtime.vocabularyListRepository.loadWordFamilies(BNC_COCA_L6);
      const priorBandTasks = stateWithAttempt.vocabularyAssessmentTasks.filter((item) => item.band === targetBand && assessment.taskIds.includes(item.id));
      const excluded = priorBandTasks.map(familyId);
      const available = (counts[targetBand] ?? 0) - excluded.length;
      targetCount = Math.min(targetCount, Math.max(0, available));
      if (targetCount > 0) {
        const samples = sampleVocabularyForAssessment({
          list: BNC_COCA_L6,
          families,
          sampleCounts: { [targetBand]: targetCount },
          excludeFamilyIds: excluded,
          seed: `${id}:${targetBand}:${priorBandTasks.length}`,
        });
        nextTasks = generateVocabularyAssessmentTasks({ samples, taskIds: samples.map(() => crypto.randomUUID()) });
        updatedAssessment = { ...assessment, taskIds: [...assessment.taskIds, ...nextTasks.map((item) => item.id)] };
      } else {
        shouldComplete = true;
      }
    }
  }

  if (shouldComplete) {
    const completeTasks = assessment.taskIds.map((taskId) => stateWithAttempt.vocabularyAssessmentTasks.find((item) => item.id === taskId)).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const completeAttempts = stateWithAttempt.vocabularyAssessmentAttempts.filter((item) => item.assessmentId === id);
    const completed = completeVocabularyAssessment({
      learner,
      assessment,
      tasks: completeTasks,
      attempts: completeAttempts,
      list: BNC_COCA_L6,
      bandWordFamilyCounts: await runtime.vocabularyListRepository.loadBandWordFamilyCounts(BNC_COCA_L6),
      now: new Date().toISOString(),
    });
    try {
      runtime.repository.save({
        ...stateWithAttempt,
        learners: stateWithAttempt.learners.map((item) => item.id === learner.id ? completed.learner : item),
        vocabularyAssessments: stateWithAttempt.vocabularyAssessments.map((item) => item.id === id ? completed.assessment : item),
      }, snapshot.revision);
    } catch (error) {
      if (!(error instanceof ConcurrencyConflictError)) throw error;
      const latest = runtime.repository.load().state;
      const current = latest.vocabularyAssessments.find((item) => item.id === id)!;
      return current.status === 'completed'
        ? NextResponse.json({ status: 'completed', result: current.result })
        : NextResponse.json({ status: 'in_progress', ...viewOf(latest, current) });
    }
    return NextResponse.json({ status: 'completed', result: completed.assessment.result, answered: completeAttempts.length, total: completeAttempts.length });
  }

  let saved;
  try {
    saved = runtime.repository.save({
      ...stateWithAttempt,
      vocabularyAssessments: stateWithAttempt.vocabularyAssessments.map((item) => item.id === id ? updatedAssessment : item),
      vocabularyAssessmentTasks: [...stateWithAttempt.vocabularyAssessmentTasks, ...nextTasks],
    }, snapshot.revision);
  } catch (error) {
    if (!(error instanceof ConcurrencyConflictError)) throw error;
    const latest = runtime.repository.load().state;
    const current = latest.vocabularyAssessments.find((item) => item.id === id)!;
    return current.status === 'completed'
      ? NextResponse.json({ status: 'completed', result: current.result })
      : NextResponse.json({ status: 'in_progress', ...viewOf(latest, current) });
  }
  const persistedAssessment = saved.state.vocabularyAssessments.find((item) => item.id === id)!;
  return NextResponse.json({ status: 'in_progress', ...viewOf(saved.state, persistedAssessment) });
}
