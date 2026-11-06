import { CONFIG } from './config';
import { STOPWORDS } from './vocab-data';
import { cleanSentences } from './book';
import { assessContinuousMaterial, type MaterialIssue } from './material';

// MFI 可理解输入任务的材料切片（RPD「MFI —— 可理解输入任务」）：
// 从书源原文切一段 150–300 词的连续篇章，要求目标 KP 出现且段内已知词覆盖率 ≥ 95%，
// 篇章 comprehension 由服务层 AI 生成并保存答案键；本模块只切出合格原文。

export interface MfiMaterial {
  passage: string;
  words: number;
  options: string[];
  answerIndex: number;
  targetChecks: readonly {
    wordId: number;
    targetWord: string;
    expectedMeaning: string;
    anchorSentence: string;
  }[];
}

export type MfiUnavailableReason = MaterialIssue | 'comprehension_context_missing' | 'topic_missing';

export type MfiSliceResult =
  | { available: true; material: MfiMaterial }
  | { available: false; reason: MfiUnavailableReason };

export interface MfiTargetWord {
  wordId: number;
  chunk: string;
  meaning: string;
}

export interface MfiSliceOptions {
  rotation?: number;
  topicTerms?: readonly string[];
  targetWords?: readonly MfiTargetWord[];
}

const TOKEN_RE = /[A-Za-z][A-Za-z'-]*/g;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normToken = (raw: string) => raw.toLowerCase().replace(/^[-']+|[-']+$/g, '');
const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean).length;

// 词形回退（与 book.ts/gloss.ts 同款保守后缀规则）：已知词表是原型（lemma），
// 篇章里是变形——候选本身须在已知集合中才算数，集合即护栏
function knownWithMorph(w: string, isKnown: (t: string) => boolean): boolean {
  if (isKnown(w)) return true;
  const cands: string[] = [];
  if (w.endsWith('ies')) cands.push(w.slice(0, -3) + 'y');
  if (w.endsWith('ing')) cands.push(w.slice(0, -3), w.slice(0, -3) + 'e');
  if (w.endsWith('ed')) cands.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -2) + 'e');
  if (w.endsWith('es')) cands.push(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) cands.push(w.slice(0, -1));
  return cands.some((c) => c.length >= 3 && isKnown(c));
}

// isKnown：调用方给出的「用户已学」判定（虚词与短词在内部视同已知，与 analyzeBook 口径一致）
export function sliceMfi(
  text: string,
  chunk: string,
  isKnown: (token: string) => boolean,
  rotation = 0
): MfiMaterial | null {
  const result = sliceMfiDetailed(text, chunk, isKnown, { rotation });
  return result.available ? result.material : null;
}

/** Like sliceMfi, but preserves the material gap so scheduling can explain it. */
export function sliceMfiDetailed(
  text: string,
  chunk: string,
  isKnown: (token: string) => boolean,
  sliceOptions: MfiSliceOptions = {}
): MfiSliceResult {
  const rotation = sliceOptions.rotation ?? 0;
  const sentences = cleanSentences(text);
  const targetWords = sliceOptions.targetWords ?? [{ wordId: 0, chunk, meaning: '' }];
  const indicesFor = (target: MfiTargetWord) => {
    const re = new RegExp(`\\b${escapeRegExp(target.chunk)}\\b`, 'i');
    return sentences.map((sentence, index) => re.test(sentence) ? index : -1).filter((index) => index >= 0);
  };
  const targetIndices = targetWords.map(indicesFor);
  if (targetIndices.some((indices) => indices.length === 0)) {
    if (sentences.length === 0 && text.trim()) {
      const sourceCheck = assessContinuousMaterial(text, {
        minWords: 1,
        maxWords: Number.MAX_SAFE_INTEGER,
        minLanguageCoverage: 0.85,
      });
      if (sourceCheck.issues.includes('language_coverage_low')) {
        return { available: false, reason: 'language_coverage_low' };
      }
      if (sourceCheck.wordCount === 0) return { available: false, reason: 'empty_text' };
    }
    return { available: false, reason: 'target_word_missing' };
  }

  const topicTerms = sliceOptions.topicTerms
    ?.map((term) => term.trim().toLocaleLowerCase())
    .filter(Boolean) ?? [];
  if (topicTerms.length === 0) return { available: false, reason: 'topic_missing' };

  // Pick the narrowest contiguous span around an occurrence of the first target
  // that contains every target. This avoids selecting an early repeated hit that
  // cannot fit the batch when a later hit can.
  const firstHits = targetIndices[0];
  const anchors = firstHits.map((center) => {
    const chosen = [center, ...targetIndices.slice(1).map((indices) =>
      [...indices].sort((a, b) => Math.abs(a - center) - Math.abs(b - center))[0]
    )];
    const lo = Math.min(...chosen);
    const hi = Math.max(...chosen);
    return { center, lo, hi, total: sentences.slice(lo, hi + 1).reduce((sum, sentence) => sum + wordsOf(sentence), 0) };
  }).sort((a, b) => a.total - b.total || a.center - b.center);
  const anchor = anchors[rotation % anchors.length];
  const center = anchor.center;
  let lo = anchor.lo;
  let hi = anchor.hi;
  let total = anchor.total;
  const containsAllTargets = () => targetIndices.every((indices) => indices.some((index) => index >= lo && index <= hi));
  while ((total < CONFIG.MFI_MIN_WORDS || !containsAllTargets()) && (lo > 0 || hi < sentences.length - 1)) {
    const missing = targetIndices.find((indices) => !indices.some((index) => index >= lo && index <= hi));
    if (missing) {
      const left = missing.filter((index) => index < lo).sort((a, b) => b - a)[0];
      const right = missing.filter((index) => index > hi).sort((a, b) => a - b)[0];
      if (left != null && (right == null || lo - left <= right - hi)) {
        lo--;
        total += wordsOf(sentences[lo]);
      } else if (right != null) {
        hi++;
        total += wordsOf(sentences[hi]);
      } else break;
    } else if (hi < sentences.length - 1 && (center - lo >= hi - center || lo === 0)) {
      hi++;
      total += wordsOf(sentences[hi]);
    } else if (lo > 0) {
      lo--;
      total += wordsOf(sentences[lo]);
    } else if (hi < sentences.length - 1) {
      hi++;
      total += wordsOf(sentences[hi]);
    }
  }
  if (!containsAllTargets()) return { available: false, reason: 'target_word_missing' };
  if (total < CONFIG.MFI_MIN_WORDS) return { available: false, reason: 'too_short' };
  if (total > CONFIG.MFI_MAX_WORDS) return { available: false, reason: 'too_long' };
  const window = sentences.slice(lo, hi + 1);

  // 已知词覆盖率：虚词 + 短词 + 已学词 的 token 占比（可理解输入的 95% 底线）
  let known = 0;
  let tot = 0;
  for (const s of window) {
    for (const m of s.matchAll(TOKEN_RE)) {
      const w = normToken(m[0]);
      if (!w) continue;
      tot++;
      if (w.length < 4 || STOPWORDS.has(w) || knownWithMorph(w, isKnown)) known++;
    }
  }
  if (tot === 0 || known / tot < CONFIG.MFI_COVERAGE) {
    return { available: false, reason: 'known_word_coverage_low' };
  }

  const passage = window.join(' ');
  const targetChecks = targetWords.flatMap((target) => {
    const targetRe = new RegExp(`\\b${escapeRegExp(target.chunk)}\\b`, 'i');
    const anchorSentence = window.find((sentence) => targetRe.test(sentence));
    return anchorSentence
      ? [{
          wordId: target.wordId,
          targetWord: target.chunk,
          expectedMeaning: target.meaning,
          anchorSentence,
        }]
      : [];
  });
  if (targetWords.length > 0 && targetChecks.length < targetWords.length) {
    return { available: false, reason: 'target_word_missing' };
  }

  const assessment = assessContinuousMaterial(passage, {
    minWords: CONFIG.MFI_MIN_WORDS,
    maxWords: CONFIG.MFI_MAX_WORDS,
    minLanguageCoverage: 0.85,
    topicTerms,
    targetWords: targetWords.map((target) => ({ wordId: target.wordId, text: target.chunk })),
  });
  if (!assessment.eligible) {
    const reason = assessment.issues[0] ?? 'empty_text';
    return { available: false, reason };
  }

  return { available: true, material: {
    passage,
    words: assessment.wordCount,
    // Keyed comprehension is deliberately absent here. The service layer must
    // add a validated AI question before it can issue an R continuous task.
    options: [],
    answerIndex: -1,
    targetChecks,
  } };
}
