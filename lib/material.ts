import { IELTS_WORDS } from './vocab-data';
import { analyzeBook } from './book';

// 统一的学习素材结构：无论来源是词表、书还是 IELTS，
// 最终都转成同一形状写入 words 表，复用同一套调度器。
export interface Material {
  chunk: string;
  meaning: string;
  scene: string;
  slots: string;
  substitute: string;
  step3_sentence: string;
  step4_sentences: string[];
  freq: number | null; // 来源语料中的词频，用于调度器优先引入高频词
}

export type MaterialIssue =
  | 'empty_text'
  | 'too_short'
  | 'too_long'
  | 'language_coverage_low'
  | 'known_word_coverage_low'
  | 'topic_mismatch'
  | 'target_word_missing';

export interface ContinuousMaterialRequirements {
  minWords: number;
  maxWords: number;
  minLanguageCoverage?: number;
  topicTerms?: readonly string[];
  targetWords?: readonly { wordId: number; text: string }[];
  minimumTopicCoverage?: number;
}

export interface ContinuousMaterialAssessment {
  eligible: boolean;
  wordCount: number;
  languageCoverage: number;
  topicCoverage: number;
  targetWordIds: readonly number[];
  issues: readonly MaterialIssue[];
}

export interface ContinuousTimingEvidence {
  wordCount: number;
  durationMs: number;
  wordsPerMinute: number;
}

/** A speed result is usable only when both the measured span and duration are real. */
export function continuousTimingEvidence(
  wordCount: number,
  durationMs: number
): ContinuousTimingEvidence | null {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const wordsPerMinute = (wordCount * 60_000) / durationMs;
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) return null;
  return { wordCount, durationMs, wordsPerMinute };
}

const materialTokens = (text: string): string[] =>
  (text.match(/[\p{L}][\p{L}'’-]*/gu) ?? []).map((token) => token.toLocaleLowerCase());

/**
 * Check whether a passage is usable for continuous reading or writing evidence.
 * Topic matching is opt-in: callers provide the expected topic vocabulary when
 * the source has a declared topic; a passage without topic metadata is not guessed.
 */
export function assessContinuousMaterial(
  text: string,
  requirements: ContinuousMaterialRequirements
): ContinuousMaterialAssessment {
  const tokens = materialTokens(text);
  const latinTokens = text.match(/[\p{Script=Latin}][\p{Script=Latin}'’-]*/gu) ?? [];
  const wordCount = tokens.length;
  const languageCoverage = wordCount === 0 ? 0 : latinTokens.length / wordCount;
  const issues: MaterialIssue[] = [];

  if (wordCount === 0) issues.push('empty_text');
  else {
    if (wordCount < requirements.minWords) issues.push('too_short');
    if (wordCount > requirements.maxWords) issues.push('too_long');
  }
  if (languageCoverage < (requirements.minLanguageCoverage ?? 0.85)) {
    issues.push('language_coverage_low');
  }

  const normalized = new Set(tokens);
  const topicTerms = (requirements.topicTerms ?? [])
    .map((term) => term.toLocaleLowerCase().trim())
    .filter(Boolean);
  const topicHits = topicTerms.filter((term) => normalized.has(term)).length;
  const topicCoverage = topicTerms.length === 0 ? 1 : topicHits / topicTerms.length;
  if (
    topicTerms.length > 0 &&
    topicCoverage < (requirements.minimumTopicCoverage ?? 0.2)
  ) issues.push('topic_mismatch');

  const requestedTargets = requirements.targetWords ?? [];
  const targetWordIds = requestedTargets
    .filter(({ text: target }) => {
      const escaped = target.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return escaped.length > 0 && new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    })
    .map(({ wordId }) => wordId);
  if (requestedTargets.length > 0 && targetWordIds.length < requestedTargets.length) {
    issues.push('target_word_missing');
  }

  return {
    eligible: issues.length === 0,
    wordCount,
    languageCoverage,
    topicCoverage,
    targetWordIds,
    issues,
  };
}

export interface WordAssessmentOutcome {
  wordId: number;
  targetWordCorrect: boolean;
  overallCorrect: boolean;
}

/** Attribute each evidence result to a specific target word for server scoring. */
export function attributeWordEvidence(
  outcomes: readonly WordAssessmentOutcome[]
): Readonly<Record<number, { target_word: boolean; overall: boolean }>> {
  return Object.fromEntries(
    outcomes.map(({ wordId, targetWordCorrect, overallCorrect }) => [wordId, {
      target_word: targetWordCorrect,
      overall: overallCorrect,
    }])
  );
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 词表导入：每行一个词条，支持 "chunk - 释义" 格式。
// 无原文语境，Step 3 退化为"根据释义回忆"，Step 4 退化为闪视语块本身。
export function materialsFromWordlist(text: string): Material[] {
  const materials: Material[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(.+?)\s+[-–—:]\s+(.+)$/);
    const chunk = (m ? m[1] : trimmed).trim();
    const meaning = m ? m[2].trim() : '';
    materials.push({
      chunk,
      meaning,
      scene: '（词表导入）',
      slots: chunk.split(/\s+/).join(' + '),
      substitute: '',
      step3_sentence: `___（无原文语境：根据释义回忆该词）`,
      step4_sentences: [chunk],
      freq: null,
    });
  }
  return materials;
}

// 书导入：从分析统计生成语块。Step 3 = 另一句原文挖空（天然真实语境），
// Step 4 = 含该词的至多 3 个原句闪视。专有名词已在分析阶段剔除。
export function materialFromStat(
  title: string,
  s: { word: string; count: number; sentences: string[] }
): Material {
  const re = new RegExp(`\\b${escapeRegExp(s.word)}\\b`, 'i');
  const step3Source = s.sentences[1] ?? s.sentences[0];
  return {
    chunk: s.word,
    meaning: '',
    scene: `出自《${title}》 · 出现 ${s.count} 次`,
    slots: s.word,
    substitute: '',
    step3_sentence: step3Source ? step3Source.replace(re, '___') : `___ (${s.word})`,
    step4_sentences: s.sentences.length > 0 ? s.sentences : [s.word],
    freq: s.count,
  };
}

export function materialsFromBook(title: string, text: string, count: number): Material[] {
  return analyzeBook(text)
    .words.filter((w) => !w.isProper)
    .slice(0, count)
    .map((s) => materialFromStat(title, s));
}

// IELTS 目标：内置学术核心词，例句挖空当 Step 3，例句当 Step 4。
export function materialsFromIelts(): Material[] {
  return IELTS_WORDS.map(({ word, gloss, sentence }) => ({
    chunk: word,
    meaning: gloss,
    scene: 'IELTS 学术核心词',
    slots: word,
    substitute: '',
    step3_sentence: sentence.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i'), '___'),
    step4_sentences: [sentence],
    freq: null,
  }));
}
