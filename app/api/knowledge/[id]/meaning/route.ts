import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = getRuntime();
  await runtime.ready;
  const snapshot = runtime.repository.load();
  const point = snapshot.state.knowledgePoints.find((item) => item.id === id);
  if (!point) return NextResponse.json({ reason: 'knowledge_point_not_found' }, { status: 404 });
  const current = point.sense.chineseMeaning?.trim();
  if (current) return NextResponse.json({ status: 'already_available', chineseMeaning: current });

  const translated = await runtime.translateSenseMeaning(point.sense.id, point.sense.definition);
  if (!translated?.trim()) return NextResponse.json({ status: 'unavailable', chineseMeaning: null });

  const latest = runtime.repository.load();
  const latestPoint = latest.state.knowledgePoints.find((item) => item.id === id);
  if (!latestPoint) return NextResponse.json({ reason: 'knowledge_point_not_found' }, { status: 404 });
  const saved = latestPoint.sense.chineseMeaning?.trim() || translated.trim();
  const updatedPoint = { ...latestPoint, sense: { ...latestPoint.sense, chineseMeaning: saved } };
  runtime.repository.save({
    ...latest.state,
    knowledgePoints: latest.state.knowledgePoints.map((item) => item.id === id ? updatedPoint : item),
    materialAnalyses: latest.state.materialAnalyses.map((analysis) => ({
      ...analysis,
      items: analysis.items.map((item) => item.knowledgePoint.id === id
        ? { ...item, knowledgePoint: updatedPoint }
        : item),
    })),
  }, latest.revision);
  return NextResponse.json({ status: 'completed', chineseMeaning: saved });
}
