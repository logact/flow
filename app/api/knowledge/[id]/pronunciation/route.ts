import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';
const activeLookups = new Set<string>();

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
  if (activeLookups.has(id)) return NextResponse.json({ reason: 'pronunciation_lookup_in_progress' }, { status: 409 });
  activeLookups.add(id);
  try {
    runtime.repository.save({
      ...snapshot.state,
      knowledgePoints: snapshot.state.knowledgePoints.map((item) => item.id === id ? { ...item, pronunciationStatus: 'processing' } : item),
    }, snapshot.revision);
    const pronunciation = await runtime.pronunciationLookup(point.lemma, point.sense.partOfSpeech);
    const latest = runtime.repository.load();
    runtime.repository.save({
      ...latest.state,
      knowledgePoints: latest.state.knowledgePoints.map((item) => item.id === id
        ? { ...item, pronunciation: pronunciation ?? item.pronunciation ?? null, pronunciationStatus: pronunciation ? 'complete' : 'failed' }
        : item),
    }, latest.revision);
    return NextResponse.json({ pronunciation, available: Boolean(pronunciation), status: pronunciation ? 'complete' : 'failed' });
  } catch (error) {
    const latest = runtime.repository.load();
    runtime.repository.save({
      ...latest.state,
      knowledgePoints: latest.state.knowledgePoints.map((item) => item.id === id ? { ...item, pronunciationStatus: 'failed' } : item),
    }, latest.revision);
    return NextResponse.json({ reason: error instanceof Error ? error.message : 'pronunciation_lookup_failed', status: 'failed' }, { status: 502 });
  } finally {
    activeLookups.delete(id);
  }
}
