import { NextResponse } from 'next/server';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';
export const maxDuration = 360;

const inFlight = new Map<string, Promise<{ knowledgePointId: string; status: 'complete' | 'failed' | 'skipped'; error?: string }>>();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { knowledgePointIds?: unknown } | null;
  if (!Array.isArray(body?.knowledgePointIds) || body.knowledgePointIds.length === 0 || body.knowledgePointIds.some(item => typeof item !== 'string' || !item.trim())) {
    return NextResponse.json({ reason: 'invalid_input' }, { status: 400 });
  }
  const ids = [...new Set(body.knowledgePointIds as string[])];
  const runtime = getRuntime(); await runtime.ready;
  const learner = await getDemoLearner();
  const state = runtime.repository.load().state;
  const material = state.materials.find(item => item.id === id && item.learnerId === learner.id);
  const analysis = state.materialAnalyses.filter(item => item.materialId === id).at(-1);
  if (!material || !analysis || analysis.status !== 'analyzed') return NextResponse.json({ reason: 'analysis_not_found' }, { status: 404 });
  if (ids.some(kpId => !analysis.items.some(item => item.knowledgePoint.id === kpId))) return NextResponse.json({ reason: 'knowledge_point_not_in_material' }, { status: 400 });

  const results = await Promise.all(ids.map(kpId => {
    const key = `${learner.id}:${id}:${kpId}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const currentAnalysis = runtime.repository.load().state.materialAnalyses.filter(item => item.materialId === id).at(-1);
      if (currentAnalysis?.status !== 'analyzed') return { knowledgePointId: kpId, status: 'skipped' as const };
      const current = currentAnalysis.items.find(item => item.knowledgePoint.id === kpId);
      if (!current || current.knowledgePoint.sense.chineseMeaning?.trim()) return { knowledgePointId: kpId, status: 'skipped' as const };
      const now = new Date().toISOString();
      const operationId = crypto.randomUUID();
      const claimed = await runtime.repository.claimChineseMeaning?.(kpId, operationId, now, 10 * 60 * 1000) ?? true;
      if (!claimed) return { knowledgePointId: kpId, status: 'skipped' as const };
      const processingPoint = { ...current.knowledgePoint, sense: { ...current.knowledgePoint.sense, chineseMeaningStatus: 'processing' as const, chineseMeaningError: null } };
      const processing = { ...currentAnalysis, items: currentAnalysis.items.map(item => item.knowledgePoint.id === kpId ? { ...item, knowledgePoint: processingPoint } : item) };
      await runtime.repository.saveMaterialWithAnalysis(material, processing);
      try {
        const meaning = await runtime.translateSenseMeaning(processingPoint.sense.id, processingPoint.sense.definition);
        if (!meaning?.trim()) throw new Error('中文释义服务未返回结果');
        const point = { ...processingPoint, sense: { ...processingPoint.sense, chineseMeaning: meaning.trim(), chineseMeaningStatus: 'complete' as const, chineseMeaningError: null } };
        const latest = runtime.repository.load().state.materialAnalyses.filter(item => item.materialId === id).at(-1);
        if (latest?.status === 'analyzed') await runtime.repository.saveMaterialWithAnalysis(material, { ...latest, items: latest.items.map(item => item.knowledgePoint.id === kpId ? { ...item, knowledgePoint: point } : item) });
        await runtime.repository.finishChineseMeaning?.(kpId, operationId, 'complete', new Date().toISOString());
        return { knowledgePointId: kpId, status: 'complete' as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const latest = runtime.repository.load().state.materialAnalyses.filter(item => item.materialId === id).at(-1);
        if (latest?.status === 'analyzed') {
          const point = { ...processingPoint, sense: { ...processingPoint.sense, chineseMeaningStatus: 'failed' as const, chineseMeaningError: message } };
          await runtime.repository.saveMaterialWithAnalysis(material, { ...latest, items: latest.items.map(item => item.knowledgePoint.id === kpId ? { ...item, knowledgePoint: point } : item) });
        }
        await runtime.repository.finishChineseMeaning?.(kpId, operationId, 'failed', new Date().toISOString());
        return { knowledgePointId: kpId, status: 'failed' as const, error: message };
      }
    })();
    inFlight.set(key, task);
    void task.finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
    return task;
  }));
  return NextResponse.json({ results });
}
