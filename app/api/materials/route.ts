import { NextResponse } from 'next/server';
import { importMaterialUseCase } from '@/lib/application/material-import';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/** 材料列表及其最新分析摘要。 */
export async function GET() {
  const runtime = getRuntime();
  await runtime.ready;
  const state = runtime.repository.load().state;
  const materials = state.materials.map((material) => {
    const analyses = state.materialAnalyses.filter((item) => item.materialId === material.id);
    const latest = analyses.at(-1) ?? null;
    return {
      id: material.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
      createdAt: material.createdAt,
      analysis: latest
        ? {
            id: latest.id,
            status: latest.status,
            itemCount: latest.items.length,
            unmatchedCount: latest.unmatchedItems.length,
            createdAt: latest.createdAt,
          }
        : null,
    };
  });
  return NextResponse.json({ materials });
}

/**
 * 导入材料（S04）：JSON 提交 { filename?, title?, text } 或 { filename, base64 }。
 * 文本提取、术语提取、词义归属都在应用层完成；AI 消歧仅在配置了 LLM_API_KEY 时启用。
 */
export async function POST(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => null)) as {
    filename?: string;
    title?: string;
    text?: string;
    base64?: string;
  } | null;
  if (!body || (!body.text && !body.base64)) {
    return NextResponse.json({ reason: 'invalid_input', message: '需要 text 或 base64 内容' }, { status: 400 });
  }

  const result = await importMaterialUseCase(
    {
      repository: runtime.repository,
      senseInventory: runtime.senseInventory,
      senseDisambiguator: runtime.llmConfigured ? runtime.senseDisambiguator : undefined,
      vocabularyFilter: runtime.vocabularyFilter,
    },
    {
      materialId: crypto.randomUUID(),
      analysisId: crypto.randomUUID(),
      learnerId: learner.id,
      title: body.title?.trim() || undefined,
      filename: body.filename?.trim() || 'pasted-material.txt',
      extractedText: body.text,
      rawFile: body.base64 ? new Uint8Array(Buffer.from(body.base64, 'base64')) : undefined,
      analyzerVersion: 'web-v1',
      now: new Date().toISOString(),
    },
  );

  if (!result.ok) {
    return NextResponse.json({ reason: result.reason }, { status: 400 });
  }
  return NextResponse.json({
    material: {
      id: result.material.id,
      title: result.material.title,
      filename: result.material.filename,
      format: result.material.format,
    },
    analysis: {
      id: result.analysis.id,
      itemCount: result.analysis.items.length,
      unmatchedCount: result.analysis.unmatchedItems.length,
      items: result.analysis.items.map((item) => ({
        knowledgePointId: item.knowledgePoint.id,
        lemma: item.knowledgePoint.kind === 'word' || item.knowledgePoint.kind === 'phrase'
          ? item.knowledgePoint.lemma
          : item.knowledgePoint.sense.definition,
        definition: item.knowledgePoint.sense.definition,
        partOfSpeech: item.knowledgePoint.sense.partOfSpeech,
        occurrenceCount: item.occurrences.length,
      })),
      unmatched: result.analysis.unmatchedItems.map((item) => ({
        lemma: item.lemma ?? null,
        reason: item.reason,
        occurrenceCount: item.occurrences.length,
      })),
    },
  });
}
