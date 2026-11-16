import { NextResponse } from 'next/server';
import { importMaterialUseCase } from '@/lib/application/material-import';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';
const analyzing = new Set<string>();
const ANALYSIS_TIMEOUT_MS = 2 * 60 * 1000;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const state = runtime.repository.load().state;
  const material = state.materials.find((item) => item.id === id);
  if (!material) return NextResponse.json({ reason: 'material_not_found' }, { status: 404 });
  if (analyzing.has(id)) return NextResponse.json({ reason: 'analysis_in_progress' }, { status: 409 });
  const latest = state.materialAnalyses.filter((item) => item.materialId === id).at(-1);
  if (latest?.status === 'analyzed') return NextResponse.json({ status: 'analyzed', analysisId: latest.id, itemCount: latest.items.length });
  if (latest?.status === 'pending' && Date.now() - Date.parse(latest.createdAt) < ANALYSIS_TIMEOUT_MS) {
    return NextResponse.json({ reason: 'analysis_in_progress', status: 'pending', retryAfterMs: ANALYSIS_TIMEOUT_MS - (Date.now() - Date.parse(latest.createdAt)) }, { status: 409 });
  }
  if (!material.extractedText?.trim()) return NextResponse.json({ reason: 'material_text_missing' }, { status: 400 });

  analyzing.add(id);
  if (latest?.status === 'pending') {
    await runtime.repository.saveMaterialAnalysis(id, { ...latest, status: 'failed', errors: ['analysis_timed_out'], completedAt: new Date().toISOString() });
  }
  const analysisId = crypto.randomUUID();
  const now = new Date().toISOString();
  await runtime.repository.saveMaterialAnalysis(id, { id: analysisId, materialId: id, analyzerVersion: 'web-v1', createdAt: now, status: 'pending', items: [], unmatchedItems: [], errors: [], completedAt: null });
  try {
    const result = await importMaterialUseCase({
      repository: runtime.repository,
      senseInventory: runtime.senseInventory,
      senseDisambiguator: runtime.llmConfigured ? runtime.senseDisambiguator : undefined,
      translateSenseMeaning: runtime.translateSenseMeaning,
      vocabularyFilter: runtime.vocabularyFilter,
      pronunciationLookup: runtime.pronunciationLookup,
    }, {
      materialId: material.id,
      analysisId,
      learnerId: learner.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
      mimeType: material.mimeType,
      checksum: material.checksum,
      storageKey: material.storageKey,
      extractedText: material.extractedText,
      analyzerVersion: 'web-v1',
      now,
    });
    if (!result.ok) {
      const message = result.reason;
      await runtime.repository.saveMaterialAnalysis(id, { id: analysisId, materialId: id, analyzerVersion: 'web-v1', createdAt: now, status: 'failed', items: [], unmatchedItems: [], errors: [message], completedAt: new Date().toISOString() });
      return NextResponse.json({ status: 'failed', reason: message }, { status: 502 });
    }
    return NextResponse.json({ status: 'analyzed', analysisId, itemCount: result.analysis.items.length, unmatchedCount: result.analysis.unmatchedItems.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'analysis_failed';
    await runtime.repository.saveMaterialAnalysis(id, { id: analysisId, materialId: id, analyzerVersion: 'web-v1', createdAt: now, status: 'failed', items: [], unmatchedItems: [], errors: [message], completedAt: new Date().toISOString() });
    return NextResponse.json({ status: 'failed', reason: message }, { status: 502 });
  } finally {
    analyzing.delete(id);
  }
}
