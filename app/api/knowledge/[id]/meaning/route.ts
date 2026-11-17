import { NextResponse } from 'next/server';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const snapshot = runtime.repository.load();
  const point = snapshot.state.knowledgePoints.find((item) => item.id === id);
  if (!point) return NextResponse.json({ reason: 'knowledge_point_not_found' }, { status: 404 });
  const belongsToLearner = snapshot.state.materialAnalyses.some(analysis => analysis.materialId && snapshot.state.materials.some(material => material.id === analysis.materialId && material.learnerId === learner.id) && analysis.status === 'analyzed' && analysis.items.some(item => item.knowledgePoint.id === id))
    || snapshot.state.learnerKnowledgePoints.some(item => item.learnerId === learner.id && item.knowledgePointId === id);
  if (!belongsToLearner) return NextResponse.json({ reason: 'knowledge_point_not_found' }, { status: 404 });
  const current = point.sense.chineseMeaning?.trim();
  if (current) return NextResponse.json({ status: 'already_available', chineseMeaning: current });
  const now = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const claimed = await runtime.repository.claimChineseMeaning?.(id, operationId, now, 10 * 60 * 1000) ?? true;
  if (!claimed) return NextResponse.json({ status: 'processing', chineseMeaning: null }, { status: 202 });
  const processingSnapshot = runtime.repository.load();
  const processingPoint = processingSnapshot.state.knowledgePoints.find(item => item.id === id);
  if (processingPoint && !processingPoint.sense.chineseMeaning?.trim()) {
    const updated = { ...processingPoint, sense: { ...processingPoint.sense, chineseMeaningStatus: 'processing' as const, chineseMeaningError: null } };
    runtime.repository.save({
      ...processingSnapshot.state,
      knowledgePoints: processingSnapshot.state.knowledgePoints.map(item => item.id === id ? updated : item),
      materialAnalyses: processingSnapshot.state.materialAnalyses.map(analysis => analysis.status === 'analyzed' ? ({ ...analysis, items: analysis.items.map(item => item.knowledgePoint.id === id ? { ...item, knowledgePoint: updated } : item) }) : analysis),
    }, processingSnapshot.revision);
  }

  const translated = await runtime.translateSenseMeaning(point.sense.id, point.sense.definition);
  if (!translated?.trim()) {
    const latest = runtime.repository.load();
    const latestPoint = latest.state.knowledgePoints.find((item) => item.id === id);
    if (latestPoint) {
      const failedPoint = { ...latestPoint, sense: { ...latestPoint.sense, chineseMeaningStatus: 'failed' as const, chineseMeaningError: '中文释义服务未返回结果' } };
      runtime.repository.save({
        ...latest.state,
        knowledgePoints: latest.state.knowledgePoints.map(item => item.id === id ? failedPoint : item),
        materialAnalyses: latest.state.materialAnalyses.map(analysis => analysis.status === 'analyzed' ? ({ ...analysis, items: analysis.items.map(item => item.knowledgePoint.id === id ? { ...item, knowledgePoint: failedPoint } : item) }) : analysis),
      }, latest.revision);
    }
    await runtime.repository.finishChineseMeaning?.(id, operationId, 'failed', new Date().toISOString());
    return NextResponse.json({ status: 'unavailable', chineseMeaning: null });
  }

  const latest = runtime.repository.load();
  const latestPoint = latest.state.knowledgePoints.find((item) => item.id === id);
  if (!latestPoint) return NextResponse.json({ reason: 'knowledge_point_not_found' }, { status: 404 });
  const saved = latestPoint.sense.chineseMeaning?.trim() || translated.trim();
  const updatedPoint = { ...latestPoint, sense: { ...latestPoint.sense, chineseMeaning: saved, chineseMeaningStatus: 'complete' as const, chineseMeaningError: null } };
  runtime.repository.save({
    ...latest.state,
    knowledgePoints: latest.state.knowledgePoints.map((item) => item.id === id ? updatedPoint : item),
    materialAnalyses: latest.state.materialAnalyses.map((analysis) => analysis.status === 'analyzed' ? ({
      ...analysis,
      items: analysis.items.map((item) => item.knowledgePoint.id === id
        ? { ...item, knowledgePoint: updatedPoint }
        : item),
    }) : analysis),
  }, latest.revision);
  await runtime.repository.finishChineseMeaning?.(id, operationId, 'complete', new Date().toISOString());
  return NextResponse.json({ status: 'completed', chineseMeaning: saved });
}
