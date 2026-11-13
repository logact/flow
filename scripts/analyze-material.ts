/**
 * S04 真实材料探针：把一份真实材料灌进 importMaterialUseCase 全链路。
 * 用法：npx tsx scripts/analyze-material.ts <材料文件> [结果输出文件]
 * 词义库 / 词频词表用正式数据，AI Provider 用环境变量（LLM_API_KEY 等）；
 * 词表过滤启用默认策略（滤掉 BNC/COCA 1k 基础频段）。
 * AI 交互审计（完整 prompt 与响应）写入 logs/ai.log。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { importMaterialUseCase } from '../lib/application/material-import';
import { loadSenseInventoryFromFile } from '../lib/application/sense-inventory';
import { createVocabularyFilter, loadVocabularyIndexFromFile } from '../lib/application/vocabulary-index';
import { createSenseDisambiguatorFromEnv } from '../lib/application/sense-disambiguator';
import { logger } from '../lib/application/logger';
import type { AnalyzedMaterialAnalysis } from '../lib/application/ports';
import type { Material } from '../lib/domain/model';

const filePath = process.argv[2] ?? 'data/foreign-language_1125.pdf';
const outPath = process.argv[3] ?? 'data/analysis-foreign-language_1125.json';

const rawFile = new Uint8Array(readFileSync(filePath));
const senseInventory = loadSenseInventoryFromFile('data/sense-inventory-v1.json');
const vocabularyFilter = createVocabularyFilter(loadVocabularyIndexFromFile('data/bnc-coca-l6-v2.0.0.json'));
const senseDisambiguator = createSenseDisambiguatorFromEnv(process.env, logger);

let saved: { material: Material; analysis: AnalyzedMaterialAnalysis } | null = null;
const repository = {
  async saveMaterialWithAnalysis(material: Material, analysis: AnalyzedMaterialAnalysis) {
    saved = { material, analysis };
  },
};

logger.info({ filePath, rawBytes: rawFile.length }, '探针：开始分析材料');

async function main() {
  const result = await importMaterialUseCase(
    { repository, senseInventory, senseDisambiguator, vocabularyFilter, logger },
    {
      materialId: `probe-${Date.now()}`,
      analysisId: `probe-analysis-${Date.now()}`,
      learnerId: 'learner-probe',
      filename: filePath.slice(filePath.lastIndexOf('/') + 1),
      rawFile,
      analyzerVersion: 'material-analyzer-v1',
      now: new Date().toISOString(),
    },
  );

  if (!result.ok) {
    logger.error({ reason: result.reason }, '探针：分析失败');
    process.exit(1);
  }
  if (!saved) {
    logger.error({}, '探针：Repository 未收到保存');
    process.exit(1);
  }

  const { material, analysis } = saved;
  const output = {
    generatedAt: new Date().toISOString(),
    source: filePath,
    filterPolicy: { excludeBands: ['1k'] },
    material: {
      id: material.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
      textChars: material.extractedText?.length ?? 0,
      extractionMetadata: material.extractionMetadata,
    },
    summary: {
      knowledgePointCount: analysis.items.length,
      excludedCount: analysis.unmatchedItems.length,
      placeholderCount: analysis.items.filter((item) => item.knowledgePoint.sense.id === 'placeholder:1').length,
      totalOccurrences: analysis.items.reduce((total, item) => total + item.occurrences.length, 0),
    },
    items: analysis.items.map((item) => ({
      knowledgePointId: item.knowledgePoint.id,
      lemma: item.knowledgePoint.kind === 'word' ? item.knowledgePoint.lemma : null,
      sense: item.knowledgePoint.sense,
      occurrenceCount: item.occurrences.length,
      occurrences: item.occurrences,
    })),
    // 被排除的词仍然可见：词元 + 拦截原因 + 出现次数（不展开出现记录，控制文件体积）
    excluded: analysis.unmatchedItems.map((item) => ({
      lemma: item.lemma ?? null,
      reason: item.reason,
      occurrenceCount: item.occurrences.length,
    })),
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  logger.info({ outPath, ...output.summary }, '探针：分析完成，结果已写入');
}

main().catch((error) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, '探针：未捕获异常');
  process.exit(1);
});
