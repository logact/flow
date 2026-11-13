import { NextResponse } from 'next/server';
import { submitVocabularyAssessmentUseCase } from '@/lib/application/vocabulary-assessment';
import { BNC_COCA_L6, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 提交一条词汇自评（S03）；全部自评完成后返回词汇水平估计。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const runtime = getRuntime();
  await runtime.ready;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    taskId?: string;
    known?: boolean;
    attemptId?: string;
  } | null;
  if (!body?.taskId || typeof body.known !== 'boolean') {
    return NextResponse.json({ reason: 'invalid_input', message: '需要 taskId 与 known' }, { status: 400 });
  }

  const result = await submitVocabularyAssessmentUseCase(
    { repository: runtime.repository, vocabularyListRepository: runtime.vocabularyListRepository },
    {
      assessmentId: id,
      taskId: body.taskId,
      attemptId: body.attemptId?.trim() || crypto.randomUUID(),
      known: body.known,
      answeredAt: new Date().toISOString(),
      list: BNC_COCA_L6,
    },
  );

  if (!result.ok) {
    const status = result.reason === 'assessment_not_found' || result.reason === 'task_not_found' ? 404 : 400;
    return NextResponse.json({ reason: result.reason }, { status });
  }
  if (result.status === 'in_progress') {
    return NextResponse.json({ status: 'in_progress', answered: result.answered, total: result.total });
  }
  return NextResponse.json({ status: 'completed', result: result.result });
}
