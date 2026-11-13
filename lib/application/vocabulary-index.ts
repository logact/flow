import { readFileSync } from 'node:fs';
import type { VocabularyFamily, VocabularyIndex } from './ports';

interface FamilyRecord {
  headword?: unknown;
  band?: unknown;
  members?: unknown;
  totalFrequency?: unknown;
}

/**
 * 从 BNC/COCA 词族清单 JSON（如 data/bnc-coca-l6-v2.0.0.json）加载词频词表。
 * headword 与全部 members 都建立索引，lemma 归并后的大小写不敏感查询都能命中。
 */
export function loadVocabularyIndexFromFile(path: string): VocabularyIndex {
  const raw: { families?: FamilyRecord[] } = JSON.parse(readFileSync(path, 'utf8'));
  const entries = new Map<string, VocabularyFamily>();
  for (const family of raw.families ?? []) {
    const info: VocabularyFamily = {
      band: String(family.band),
      totalFrequency: Number(family.totalFrequency) || 0,
    };
    entries.set(String(family.headword).toLocaleLowerCase('en'), info);
    for (const member of Array.isArray(family.members) ? family.members : []) {
      entries.set(String(member).toLocaleLowerCase('en'), info);
    }
  }
  return {
    lookup: (lemma) => entries.get(lemma.toLocaleLowerCase('en')) ?? null,
  };
}

export interface VocabularyFilterOptions {
  /**
   * 这些频段的词不生成知识点（例如 ['1k', '2k'] 表示基础词已掌握）。
   * 缺省 ['1k']：默认滤掉最基础的前 1000 词族；传空数组可关闭频段过滤。
   */
  excludeBands?: string[];
  /** 词族总频次达到该值的词不生成知识点（超高频小词过滤）。 */
  excludeFrequencyAtOrAbove?: number;
  /** 学习者已掌握的词不生成知识点。 */
  isKnown?: (lemma: string) => boolean;
}

/**
 * 由词频词表生成"是否值得学习"的过滤谓词：true 保留（需要义项归属），false 过滤。
 * 默认策略：不在词族表中的词不收录，且滤掉 1k 基础频段。
 * 词义库构建时已被词族表过滤（收录的词必然命中词族），因此本谓词同时是"成员资格"闸门。
 */
/** 词表过滤判定结果：keep=false 时 reason 记录被拦截的具体原因。 */
export interface VocabularyDecision {
  keep: boolean;
  reason?: string;
}

/**
 * 由词频词表生成"是否值得学习"的判定谓词，被拦截时给出原因
 * （known / not-in-word-family / band:{band} / frequency>={n}）。
 * 过滤策略与 createVocabularyFilter 完全一致。
 */
export function createVocabularyDecisionFilter(
  index: VocabularyIndex,
  options: VocabularyFilterOptions = {},
): (lemma: string) => VocabularyDecision {
  const bands = new Set(options.excludeBands ?? ['1k']);
  return (lemma) => {
    if (options.isKnown?.(lemma)) return { keep: false, reason: 'known' };
    const family = index.lookup(lemma);
    if (!family) return { keep: false, reason: 'not-in-word-family' };
    if (bands.has(family.band)) return { keep: false, reason: `band:${family.band}` };
    if (options.excludeFrequencyAtOrAbove !== undefined
      && family.totalFrequency >= options.excludeFrequencyAtOrAbove) {
      return { keep: false, reason: `frequency>=${options.excludeFrequencyAtOrAbove}` };
    }
    return { keep: true };
  };
}

/**
 * 由词频词表生成"是否值得学习"的过滤谓词：true 保留（需要义项归属），false 过滤。
 * 默认策略：不在词族表中的词不收录，且滤掉 1k 基础频段。
 * 词义库构建时已被词族表过滤（收录的词必然命中词族），因此本谓词同时是"成员资格"闸门。
 * 需要拦截原因时请用 createVocabularyDecisionFilter。
 */
export function createVocabularyFilter(
  index: VocabularyIndex,
  options: VocabularyFilterOptions = {},
): (lemma: string) => boolean {
  const decide = createVocabularyDecisionFilter(index, options);
  return (lemma) => decide(lemma).keep;
}
