import { NextResponse } from 'next/server';
import { startVocabularyAssessmentUseCase } from '@/lib/application/vocabulary-assessment';
import type { VocabularyBand } from '@/lib/domain/model';
import { BNC_COCA_L6, getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 默认覆盖至 Nation 对受教育成年母语者约 20k 词族的粗略参照。 */
const DEFAULT_SAMPLE_COUNTS = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => [`${index + 1}k`, 5]),
) as Partial<Record<VocabularyBand, number>>;

/** 开始词汇自评定级（S02）：分层抽样生成只含被测词汇的自评任务。 */
export async function POST(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => ({}))) as {
    sampleCounts?: Partial<Record<VocabularyBand, number>>;
  };
  const sampleCounts = body.sampleCounts ?? DEFAULT_SAMPLE_COUNTS;
  if (!sampleCounts || typeof sampleCounts !== 'object' || Array.isArray(sampleCounts)) {
    return NextResponse.json({ reason: 'invalid_sample_counts' }, { status: 400 });
  }
  const requestedBeyondCap = Object.keys(sampleCounts).some((band) => {
    const match = /^(\d+)k$/.exec(band);
    return !match || Number(match[1]) > 20;
  });
  if (requestedBeyondCap) {
    return NextResponse.json({ reason: 'band_out_of_range', maximumBand: '20k' }, { status: 400 });
  }
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
