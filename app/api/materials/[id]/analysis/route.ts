import { NextResponse } from 'next/server';
import { importMaterialUseCase } from '@/lib/application/material-import';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';
import type { MaterialAnalysis, MaterialAnalysisProgress, MaterialAnalysisProgressStage } from '@/lib/domain/model';
import { logger } from '@/lib/application/logger';
import { materialAnalysisProgressLabel } from '@/lib/domain/material-analysis-status';

export const dynamic = 'force-dynamic';
export const maxDuration = 360;
const analyzing = new Set<string>();
const ANALYSIS_TIMEOUT_MS = 6 * 60 * 1000;
const MAIN_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

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
  const pendingAgeMs = latest?.status === 'pending' ? Date.now() - Date.parse(latest.createdAt) : null;
  if (pendingAgeMs !== null && Number.isFinite(pendingAgeMs) && pendingAgeMs < ANALYSIS_TIMEOUT_MS) {
    return NextResponse.json({ reason: 'analysis_in_progress', status: 'pending', retryAfterMs: ANALYSIS_TIMEOUT_MS - pendingAgeMs }, { status: 409 });
  }
  if (!material.extractedText?.trim()) return NextResponse.json({ reason: 'material_text_missing' }, { status: 400 });

  analyzing.add(id);
  const analysisId = crypto.randomUUID();
  const now = new Date().toISOString();
  let lastProgress: MaterialAnalysisProgress = { stage: 'starting', updatedAt: now };
  let pendingSaved = false;
  try {
    if (latest?.status === 'pending') {
      await runtime.repository.saveMaterialAnalysis(id, { ...latest, status: 'failed', errors: ['分析超过 6 分钟，已结束。可立即重试。'], completedAt: now });
    }
    await runtime.repository.saveMaterialAnalysis(id, { id: analysisId, materialId: id, analyzerVersion: 'web-v1', createdAt: now, status: 'pending', progress: lastProgress, items: [], unmatchedItems: [], errors: [], completedAt: null });
    pendingSaved = true;
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
      timeoutMs: MAIN_ANALYSIS_TIMEOUT_MS,
      onProgress: async (stage: MaterialAnalysisProgressStage) => {
        lastProgress = { stage, updatedAt: new Date().toISOString() };
        const pending: Extract<MaterialAnalysis, { status: 'pending' }> = { id: analysisId, materialId: id, analyzerVersion: 'web-v1', createdAt: now, status: 'pending', progress: lastProgress, items: [], unmatchedItems: [], errors: [], completedAt: null };
        try { await runtime.repository.saveMaterialAnalysis(id, pending); }
        catch (error) { logger.warn({ materialId: id, analysisId, stage, error: error instanceof Error ? error.message : String(error) }, '材料分析：进度保存失败'); }
        logger.info({ materialId: id, analysisId, stage, progressAt: lastProgress.updatedAt }, '材料分析：阶段进展');
      },
    });
    if (!result.ok) {
      const message = result.reason;
      const failedStage = materialAnalysisProgressLabel(lastProgress.stage) ?? lastProgress.stage;
      const errorMessage = message === 'analysis_timeout' ? '主要分析超过 5 分钟，已自动结束。可立即重试。' : `分析在“${failedStage}”阶段未能完成，可重试。`;
      await runtime.repository.saveMaterialAnalysis(id, { id: analysisId, materialId: id, analyzerVersion: 'web-v1', createdAt: now, status: 'failed', progress: lastProgress, items: [], unmatchedItems: [], errors: [errorMessage], completedAt: new Date().toISOString() });
      return NextResponse.json({ status: 'failed', reason: message }, { status: 502 });
    }
    return NextResponse.json({ status: 'analyzed', analysisId, itemCount: result.analysis.items.length, unmatchedCount: result.analysis.unmatchedItems.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'analysis_failed';
    if (pendingSaved) {
      try {
        const errorMessage = message === 'analysis_timeout' ? '主要分析超过 5 分钟，已自动结束。可立即重试。' : `分析失败：${message}`;
        await runtime.repository.saveMaterialAnalysis(id, { id: analysisId, materialId: id, analyzerVersion: 'web-v1', createdAt: now, status: 'failed', progress: lastProgress, items: [], unmatchedItems: [], errors: [errorMessage], completedAt: new Date().toISOString() });
      } catch { /* Preserve the original analysis failure response if failure-state persistence also fails. */ }
    }
    return NextResponse.json({ status: 'failed', reason: message }, { status: 502 });
  } finally {
    analyzing.delete(id);
  }
}
