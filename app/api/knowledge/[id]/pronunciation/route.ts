import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/server/runtime';
import { lookupPronunciationNow } from '@/lib/server/pronunciation-enrichment';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = getRuntime();
  await runtime.ready;
  const snapshot = runtime.repository.load();
  const point = snapshot.state.knowledgePoints.find((item) => item.id === id);
  if (!point) return NextResponse.json({ reason: 'knowledge_point_not_found' }, { status: 404 });
  if (point.kind !== 'word' && point.kind !== 'phrase') {
    return NextResponse.json({ reason: 'pronunciation_not_supported' }, { status: 400 });
  }
  const result = await lookupPronunciationNow(runtime, id);
  return NextResponse.json({ pronunciation: result.pronunciation, available: Boolean(result.pronunciation), status: result.status });
}
