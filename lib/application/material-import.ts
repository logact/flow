import { createHash } from 'node:crypto';
import { analyzeMaterial, createMaterial, extractMaterialTerms } from '../domain/functions';
import type { ISODateTime, Material } from '../domain/model';
import { logger as defaultLogger, type AppLogger } from './logger';
import type {
  AnalyzedMaterialAnalysis,
  MaterialRepository,
  SenseDisambiguator,
  SenseInventory,
} from './ports';
import { PLACEHOLDER_SENSE_ID, resolveSenseAssignments } from './material-sense-resolution';
import { extractTextFromFile } from './text-extraction';
import type { VocabularyDecision } from './vocabulary-index';

export interface ImportMaterialUseCaseInput {
  /** 应用层分配的材料 ID。 */
  materialId: string;
  /** 应用层分配的分析 ID。 */
  analysisId: string;
  learnerId: string;
  /** 面向学习者展示的标题；缺省时取文件名去扩展名。 */
  title?: string;
  /** 原始文件名，用于推断格式和生成默认标题。 */
  filename: string;
  /** 材料格式；缺省时按 filename 扩展名推断，推断不出返回 unsupported_format。 */
  format?: Material['format'];
  /** 原始文件 MIME 类型；缺省时按格式取常见值。 */
  mimeType?: string | null;
  /** 内容校验和；缺省时按原始文件（或已提取文本）计算 SHA-256。 */
  checksum?: string;
  /** 原始内容在外部存储中的键；内容直接内嵌时为空。 */
  storageKey?: string | null;
  /** 原始文件内容；提供时由应用层完成文本提取。与 extractedText 二选一。 */
  rawFile?: Uint8Array;
  /** 调用方已完成提取的文本；提供时不再读取 rawFile。 */
  extractedText?: string;
  /** 分析器名称或版本，用于复现分析结果。 */
  analyzerVersion: string;
  /** 当前时间。 */
  now: ISODateTime;
}

export type ImportMaterialFailure =
  | 'unsupported_format'
  | 'invalid_input'
  | 'extraction_failed'
  | 'analysis_failed';

export type ImportMaterialResult =
  | { ok: true; material: Material; analysis: AnalyzedMaterialAnalysis }
  | { ok: false; reason: ImportMaterialFailure };

const FORMAT_BY_EXTENSION: Record<string, Material['format']> = {
  txt: 'txt',
  md: 'markdown',
  markdown: 'markdown',
  pdf: 'pdf',
};

const DEFAULT_MIME_TYPE: Record<Material['format'], string> = {
  txt: 'text/plain',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
};

function basename(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1).slice(filename.lastIndexOf('\\') + 1);
  return base || filename;
}

function extensionOf(filename: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function titleFromFilename(filename: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function isSupportedFormat(format: string | undefined): format is Material['format'] {
  return format === 'txt' || format === 'markdown' || format === 'pdf';
}

/**
 * S04：导入并分析材料。
 * 应用层负责格式解析与文本提取，然后调用 createMaterial、extractMaterialTerms、analyzeMaterial：
 * 本地术语提取后，被词表过滤的词不生成知识点，单义词条按词义库直接定义项，
 * 多义词条按出现记录采样（首现 + 均匀采样，默认 ≤3 条）交给 AI 逐句判义并多数投票，
 * 得出该材料内一词一义；词表过滤与词义库未收录的词不生成知识点，
 * 未配置 AI Provider 或消歧失败回退占位义项，
 * 材料与固定版本的分析在同一次写入中保存；
 * 任何一步失败都不保存半成品，不把该材料作为已分析材料交给 S05。
 */
export async function importMaterialUseCase(
  deps: {
    repository: MaterialRepository;
    senseInventory?: SenseInventory;
    senseDisambiguator?: SenseDisambiguator;
    logger?: AppLogger;
    /**
     * 词表过滤谓词：false/{keep:false} 表示不值得学习，不生成知识点（但记入 unmatchedItems）；
     * 返回判定对象时把拦截原因一并记录；缺省全部保留。
     */
    vocabularyFilter?: (lemma: string) => boolean | VocabularyDecision;
    /** 每个多义词发给 AI 的最多出现记录数；缺省由词义消歧模块决定。 */
    maxSamplesPerTerm?: number;
    /** 单次 AI 请求的最多出现记录数；缺省由词义消歧模块决定。 */
    chunkItemLimit?: number;
    /** 单次 AI 请求的 prompt 字符预算；缺省由词义消歧模块决定。 */
    chunkCharLimit?: number;
  },
  input: ImportMaterialUseCaseInput,
): Promise<ImportMaterialResult> {
  const logger = deps.logger ?? defaultLogger;
  logger.info(
    {
      materialId: input.materialId,
      analysisId: input.analysisId,
      learnerId: input.learnerId,
      filename: input.filename,
      format: input.format ?? null,
      analyzerVersion: input.analyzerVersion,
      rawBytes: input.rawFile?.length ?? null,
      providedTextChars: input.extractedText?.length ?? null,
    },
    '材料导入：开始',
  );
  const format = input.format ?? FORMAT_BY_EXTENSION[extensionOf(input.filename)];
  if (!isSupportedFormat(format)) {
    logger.warn({ materialId: input.materialId, filename: input.filename, format }, '材料导入：失败');
    return { ok: false, reason: 'unsupported_format' };
  }

  let extractedText = input.extractedText ?? null;
  let extractionMetadata: Record<string, unknown> = { extractor: 'provided' };
  let checksum = input.checksum ?? null;

  if (input.rawFile) {
    try {
      const extracted = await extractTextFromFile(format, input.rawFile);
      extractedText = extracted.text;
      extractionMetadata = extracted.metadata;
    } catch (error) {
      logger.warn(
        { materialId: input.materialId, error: error instanceof Error ? error.message : String(error) },
        '材料导入：失败',
      );
      return { ok: false, reason: 'extraction_failed' };
    }
    checksum ??= createHash('sha256').update(input.rawFile).digest('hex');
  } else if (extractedText !== null) {
    checksum ??= createHash('sha256').update(extractedText, 'utf8').digest('hex');
  }

  if (extractedText === null || !extractedText.trim()) {
    logger.warn({ materialId: input.materialId }, '材料导入：失败（没有可分析的提取文本）');
    return { ok: false, reason: 'extraction_failed' };
  }
  if (checksum === null) {
    logger.warn({ materialId: input.materialId }, '材料导入：失败（缺少校验和）');
    return { ok: false, reason: 'invalid_input' };
  }
  logger.info(
    {
      materialId: input.materialId,
      checksum,
      textChars: extractedText.length,
      extractor: extractionMetadata.extractor ?? null,
    },
    '材料导入：文本提取完成',
  );

  let material: Material;
  try {
    material = createMaterial({
      id: input.materialId,
      learnerId: input.learnerId,
      title: input.title ?? titleFromFilename(input.filename),
      filename: input.filename,
      format,
      mimeType: input.mimeType ?? DEFAULT_MIME_TYPE[format],
      checksum,
      storageKey: input.storageKey ?? null,
      extractedText,
      extractionMetadata,
      now: input.now,
    });
  } catch {
    logger.warn({ materialId: input.materialId }, '材料导入：失败（材料构造校验未通过）');
    return { ok: false, reason: 'invalid_input' };
  }

  let analysis: AnalyzedMaterialAnalysis;
  try {
    const terms = extractMaterialTerms(material);
    const { assignments, excluded } = await resolveSenseAssignments(terms, deps);
    analysis = analyzeMaterial({
      analysisId: input.analysisId,
      material,
      analyzerVersion: input.analyzerVersion,
      now: input.now,
      assignments,
      excludedTerms: excluded,
    });
  } catch (error) {
    logger.warn(
      { materialId: input.materialId, error: error instanceof Error ? error.message : String(error) },
      '材料导入：失败（分析未完成）',
    );
    return { ok: false, reason: 'analysis_failed' };
  }

  await deps.repository.saveMaterialWithAnalysis(material, analysis);
  logger.info(
    {
      materialId: material.id,
      analysisId: analysis.id,
      analyzerVersion: analysis.analyzerVersion,
      itemCount: analysis.items.length,
      excludedCount: analysis.unmatchedItems.length,
      placeholderItemCount: analysis.items.filter(
        (item) => item.knowledgePoint.sense.id === PLACEHOLDER_SENSE_ID,
      ).length,
      termCount: analysis.items.reduce((total, item) => total + item.occurrences.length, 0),
    },
    '材料导入：分析完成并保存',
  );
  return { ok: true, material, analysis };
}
