import { NextResponse } from 'next/server';
import { startVocabularyAssessmentUseCase } from '@/lib/application/vocabulary-assessment';
import type { VocabularyBand } from '@/lib/domain/model';
import { BNC_COCA_L6, getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

const DEFAULT_SAMPLE_COUNTS: Partial<Record<VocabularyBand, number>> = {
  '1k': 5,
  '2k': 5,
  '3k': 5,
  '4k': 5,
};

/** 开始词汇自评定级（S02）：分层抽样生成只含被测词汇的自评任务。 */
export async function POST(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => ({}))) as {
    sampleCounts?: Partial<Record<VocabularyBand, number>>;
  };
  const sampleCounts = body.sampleCounts ?? DEFAULT_SAMPLE_COUNTS;
  const counts = Object.values(sampleCounts).filter((count): count is number => count !== undefined);
  const total = counts.reduce((sum, count) => sum + count, 0);

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

  if (!result.ok) {
    return NextResponse.json({ reason: result.reason }, { status: 400 });
  }
  return NextResponse.json({ assessmentId: result.assessmentId, tasks: result.tasks });
}
