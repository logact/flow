import type { MaterialTerm, TermSenseAssignment } from '../domain/functions';
import type { Occurrence } from '../domain/model';
import { logger as defaultLogger, type AppLogger } from './logger';
import type {
  InventorySense,
  SenseDisambiguationItem,
  SenseDisambiguator,
  SenseInventory,
} from './ports';
import type { VocabularyDecision } from './vocabulary-index';

/** 词义库未收录或消歧失败时使用的占位义项标识。 */
export const PLACEHOLDER_SENSE_ID = 'placeholder:1';

/** 被排除的词：不生成知识点，但连同原因保留在分析结果中供展示。 */
export interface ExcludedTerm {
  /** 归一化后的词元。 */
  lemma: string;
  /** 被排除的原因：词表过滤原因（known / not-in-word-family / band:x / frequency>=n）或 'out-of-inventory'。 */
  reason: string;
  /** 该词元在材料中的全部出现记录。 */
  occurrences: Occurrence[];
}

/** 义项归属管线的输出：生成的知识点归属 + 被排除的词及其原因。 */
export interface SenseResolutionResult {
  assignments: TermSenseAssignment[];
  excluded: ExcludedTerm[];
}

export interface SenseResolutionDeps {
  senseInventory?: SenseInventory;
  senseDisambiguator?: SenseDisambiguator;
  logger?: AppLogger;
  /**
   * 词表过滤谓词：false/{keep:false} 表示不值得学习，不生成知识点（默认全部保留）。
   * 返回 VocabularyDecision 时把拦截原因记录进 excluded。
   */
  vocabularyFilter?: (lemma: string) => boolean | VocabularyDecision;
  /** 每个多义词发给 AI 的最多出现记录数（首现 + 均匀采样）；默认 3。 */
  maxSamplesPerTerm?: number;
  /** 单次 AI 请求的最多出现记录数；默认 64。 */
  chunkItemLimit?: number;
  /** 单次 AI 请求的 prompt 字符预算；默认 14000。 */
  chunkCharLimit?: number;
}

const DEFAULT_MAX_SAMPLES_PER_TERM = 3;
const DEFAULT_CHUNK_ITEM_LIMIT = 64;
const DEFAULT_CHUNK_CHAR_LIMIT = 14_000;

function placeholderAssignment(lemma: string, occurrences: Occurrence[]): TermSenseAssignment {
  return {
    lemma,
    senseId: PLACEHOLDER_SENSE_ID,
    partOfSpeech: null,
    definition: `Meaning of ${lemma} in the source material`,
    occurrences,
  };
}

function assignmentFromSense(
  lemma: string,
  sense: InventorySense,
  occurrences: Occurrence[],
): TermSenseAssignment {
  return {
    lemma,
    senseId: sense.id,
    partOfSpeech: sense.pos,
    definition: sense.gloss,
    occurrences,
  };
}

/**
 * 出现记录采样：首现 + 在其余出现中均匀取点。
 * 一份材料内同一个 lemma 只判一次义，采样把 AI 输入从全部出现压到 maxSamples 条以内。
 */
export function sampleOccurrenceIndexes(total: number, maxSamples: number): number[] {
  if (total <= 1 || maxSamples <= 1) return [0];
  if (total <= maxSamples) return Array.from({ length: total }, (_, index) => index);
  const indexes = [0];
  for (let i = 1; i < maxSamples; i += 1) {
    indexes.push(Math.round((i * (total - 1)) / (maxSamples - 1)));
  }
  return indexes;
}

interface LemmaGroup {
  lemma: string;
  items: SenseDisambiguationItem[];
  /** 该组在 prompt 中的估算字符数：候选表只计一次，出现记录按条累计。 */
  blockChars: number;
}

/** 按 lemma 分组，避免同一 lemma 的候选表在 prompt 中重复出现。 */
function groupItemsByLemma(items: SenseDisambiguationItem[]): LemmaGroup[] {
  const groups = new Map<string, SenseDisambiguationItem[]>();
  for (const item of items) {
    const group = groups.get(item.lemma);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.lemma, [item]);
    }
  }
  return [...groups.entries()].map(([lemma, group]) => ({
    lemma,
    items: group,
    blockChars:
      group[0].candidates.reduce((total, candidate) => total + candidate.id.length + candidate.gloss.length + 24, 80)
      + group.reduce((total, item) => total + item.sentence.length + item.context.join(' ').length + 40, 0),
  }));
}

/**
 * 把 lemma 组打包成不超过 item 数与字符预算的请求块。
 * 单个 lemma 组自身超预算时独占一块，保证每次调用至少有一个可发送条目。
 */
function packLemmaGroups(
  groups: LemmaGroup[],
  itemLimit: number,
  charLimit: number,
): SenseDisambiguationItem[][] {
  const chunks: SenseDisambiguationItem[][] = [];
  let current: SenseDisambiguationItem[] = [];
  let currentChars = 0;
  const flush = (): void => {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentChars = 0;
  };
  for (const group of groups) {
    if (current.length > 0
      && (current.length + group.items.length > itemLimit || currentChars + group.blockChars > charLimit)) {
      flush();
    }
    current.push(...group.items);
    currentChars += group.blockChars;
  }
  flush();
  return chunks;
}

interface ValidPick {
  senseId: string;
  occurrenceIndex: number;
}

/**
 * 多数投票：得票最多者胜；平票时取最早出现记录支持的义项，保证确定性。
 */
function voteWinner(picks: ValidPick[]): string {
  const tally = new Map<string, { count: number; earliest: number }>();
  for (const pick of picks) {
    const entry = tally.get(pick.senseId) ?? { count: 0, earliest: pick.occurrenceIndex };
    entry.count += 1;
    entry.earliest = Math.min(entry.earliest, pick.occurrenceIndex);
    tally.set(pick.senseId, entry);
  }
  let winner = picks[0].senseId;
  let best = tally.get(winner)!;
  for (const [senseId, entry] of tally) {
    if (entry.count > best.count || (entry.count === best.count && entry.earliest < best.earliest)) {
      winner = senseId;
      best = entry;
    }
  }
  return winner;
}

/**
 * 生成全部出现记录的义项归属：
 * 被词表过滤的词与词义库未收录的词（专名、lemma 还原失败产物、库外词）都不生成知识点，
 * 但连同原因保留在返回的 excluded 中（接入 analyzeMaterial 的 unmatchedItems，可在结果里展示）；
 * 单义词条直接选定；多义词条按出现记录采样（首现 + 均匀采样，默认 ≤3 条）交给 AI 逐句判义，
 * 按句多数投票得出该材料内唯一义项，全部出现记录归入该义项；
 * 未配置 AI Provider 或消歧失败（无任何有效投票）时回退占位义项。
 * 分析始终可以完成，AI 是增强而不是硬依赖。
 */
export async function resolveSenseAssignments(
  terms: MaterialTerm[],
  deps: SenseResolutionDeps,
): Promise<SenseResolutionResult> {
  const logger = deps.logger ?? defaultLogger;
  const maxSamples = deps.maxSamplesPerTerm ?? DEFAULT_MAX_SAMPLES_PER_TERM;
  const assignments: TermSenseAssignment[] = [];
  const excluded: ExcludedTerm[] = [];
  const ambiguousTermIndexes: number[] = [];
  const candidatesByTerm = new Map<number, InventorySense[]>();
  const sampledIndexesByTerm = new Map<number, number[]>();
  const items: SenseDisambiguationItem[] = [];
  let directCount = 0;
  let placeholderCount = 0;
  let filteredCount = 0;
  let outOfInventoryCount = 0;

  terms.forEach((term, termIndex) => {
    if (deps.vocabularyFilter) {
      const decision = deps.vocabularyFilter(term.lemma);
      const kept = typeof decision === 'boolean' ? decision : decision.keep;
      if (!kept) {
        const reason = typeof decision === 'boolean' ? 'vocabulary-filter' : decision.reason ?? 'vocabulary-filter';
        filteredCount += 1;
        excluded.push({ lemma: term.lemma, reason, occurrences: term.occurrences });
        logger.debug({ lemma: term.lemma, occurrenceCount: term.occurrences.length, reason }, '词义消歧：词表过滤，不生成知识点');
        return;
      }
    }
    const candidates = deps.senseInventory?.lookup(term.lemma) ?? [];
    if (candidates.length === 0) {
      outOfInventoryCount += 1;
      excluded.push({ lemma: term.lemma, reason: 'out-of-inventory', occurrences: term.occurrences });
      logger.debug({ lemma: term.lemma, occurrenceCount: term.occurrences.length }, '词义消歧：词义库未收录，不生成知识点');
    } else if (candidates.length === 1) {
      directCount += 1;
      assignments.push(assignmentFromSense(term.lemma, candidates[0], term.occurrences));
      logger.debug({ lemma: term.lemma, senseId: candidates[0].id }, '词义消歧：单义词条直接选定');
    } else {
      ambiguousTermIndexes.push(termIndex);
      candidatesByTerm.set(termIndex, candidates);
      const sampledIndexes = sampleOccurrenceIndexes(term.occurrences.length, maxSamples);
      sampledIndexesByTerm.set(termIndex, sampledIndexes);
      for (const occurrenceIndex of sampledIndexes) {
        items.push({
          key: `${termIndex}:${occurrenceIndex}`,
          lemma: term.lemma,
          sentence: term.occurrences[occurrenceIndex].sentence,
          context: term.occurrences[occurrenceIndex].context,
          candidates,
        });
      }
    }
  });

  const fallbackTerm = (termIndex: number): void => {
    placeholderCount += 1;
    assignments.push(placeholderAssignment(terms[termIndex].lemma, terms[termIndex].occurrences));
  };

  if (items.length === 0) {
    logger.info(
      { termCount: terms.length, directCount, placeholderCount, filteredCount, outOfInventoryCount, excludedCount: excluded.length, ambiguousCount: 0 },
      '词义消歧：无多义词条，完成义项归属',
    );
    return { assignments, excluded };
  }
  const ambiguousLemmas = ambiguousTermIndexes.map((termIndex) => terms[termIndex].lemma);
  if (!deps.senseDisambiguator) {
    logger.info(
      { termCount: ambiguousTermIndexes.length, lemmas: ambiguousLemmas },
      '词义消歧：未配置 AI Provider，多义词条回退占位义项',
    );
    ambiguousTermIndexes.forEach(fallbackTerm);
    logger.info(
      { termCount: terms.length, directCount, placeholderCount, filteredCount, outOfInventoryCount, excludedCount: excluded.length, ambiguousCount: ambiguousTermIndexes.length },
      '词义消歧：完成义项归属',
    );
    return { assignments, excluded };
  }

  const chunks = packLemmaGroups(
    groupItemsByLemma(items),
    deps.chunkItemLimit ?? DEFAULT_CHUNK_ITEM_LIMIT,
    deps.chunkCharLimit ?? DEFAULT_CHUNK_CHAR_LIMIT,
  );
  logger.info(
    {
      itemCount: items.length,
      termCount: ambiguousTermIndexes.length,
      chunkCount: chunks.length,
      lemmas: ambiguousLemmas,
    },
    '词义消歧：请求 AI Provider',
  );
  const pickByKey = new Map<string, string>();
  const failedKeys = new Set<string>();
  let failedChunkCount = 0;
  for (const [chunkIndex, chunk] of chunks.entries()) {
    try {
      const picks = await deps.senseDisambiguator.disambiguate(chunk);
      for (const pick of picks) pickByKey.set(pick.key, pick.senseId);
    } catch (error) {
      failedChunkCount += 1;
      for (const item of chunk) failedKeys.add(item.key);
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          chunkIndex,
          itemCount: chunk.length,
        },
        '词义消歧：AI 请求失败，本批次词条回退占位义项',
      );
    }
  }

  const validPicksByTerm = new Map<number, ValidPick[]>();
  for (const item of items) {
    const [termIndex, occurrenceIndex] = item.key.split(':').map(Number);
    const senseId = pickByKey.get(item.key);
    const valid = typeof senseId === 'string'
      && item.candidates.some((candidate) => candidate.id === senseId);
    if (!valid) continue;
    const picks = validPicksByTerm.get(termIndex) ?? [];
    picks.push({ senseId, occurrenceIndex });
    validPicksByTerm.set(termIndex, picks);
  }

  let disambiguatedCount = 0;
  let splitVoteCount = 0;
  const invalidLemmas: string[] = [];
  for (const termIndex of ambiguousTermIndexes) {
    const picks = validPicksByTerm.get(termIndex) ?? [];
    if (picks.length === 0) {
      const sampled = sampledIndexesByTerm.get(termIndex) ?? [];
      if (!sampled.every((occurrenceIndex) => failedKeys.has(`${termIndex}:${occurrenceIndex}`))) {
        invalidLemmas.push(terms[termIndex].lemma);
      }
      fallbackTerm(termIndex);
      continue;
    }
    const senseId = voteWinner(picks);
    const sense = candidatesByTerm.get(termIndex)?.find((candidate) => candidate.id === senseId);
    if (!sense) {
      fallbackTerm(termIndex);
      continue;
    }
    disambiguatedCount += 1;
    const distinctVotes = new Set(picks.map((pick) => pick.senseId)).size;
    if (distinctVotes > 1) splitVoteCount += 1;
    assignments.push(assignmentFromSense(terms[termIndex].lemma, sense, terms[termIndex].occurrences));
    logger.debug(
      { lemma: terms[termIndex].lemma, senseId, sampledVotes: picks.length, distinctVotes },
      '词义消歧：AI 判定完成',
    );
  }
  if (invalidLemmas.length > 0) {
    logger.warn(
      { lemmas: invalidLemmas },
      '词义消歧：AI 返回无效，整词回退占位义项',
    );
  }
  logger.info(
    {
      termCount: terms.length,
      directCount,
      placeholderCount,
      filteredCount,
      outOfInventoryCount,
      ambiguousCount: ambiguousTermIndexes.length,
      disambiguatedCount,
      splitVoteCount,
      excludedCount: excluded.length,
      itemCount: items.length,
      chunkCount: chunks.length,
      failedChunkCount,
    },
    '词义消歧：完成义项归属',
  );
  return { assignments, excluded };
}
