import { CONFIG } from './config';
import { STOPWORDS } from './vocab-data';
import { cleanSentences } from './book';
import { assessContinuousMaterial, type MaterialIssue } from './material';

// MFI 可理解输入任务的材料切片（RPD「MFI —— 可理解输入任务」）：
// 从书源原文切一段 150–300 词的连续篇章，要求目标 KP 出现且段内已知词覆盖率 ≥ 95%，
// 主旨三选一的选项由相邻段落句规则生成（原型不做 AI）。

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

export type MfiUnavailableReason = MaterialIssue | 'comprehension_context_missing';

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
  const re = new RegExp(`\\b${escapeRegExp(chunk)}\\b`, 'i');
  const hits = sentences.map((s, i) => (re.test(s) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) {
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

  // 同一 KP 多次出现时按 rotation 轮换锚点，避免每次 MFI 都切同一段
  const center = hits[rotation % hits.length];
  let lo = center;
  let hi = center;
  let total = wordsOf(sentences[center]);
  while (total < CONFIG.MFI_MIN_WORDS && (lo > 0 || hi < sentences.length - 1)) {
    if (hi < sentences.length - 1) {
      hi++;
      total += wordsOf(sentences[hi]);
    }
    if (total >= CONFIG.MFI_MIN_WORDS) break;
    if (lo > 0) {
      lo--;
      total += wordsOf(sentences[lo]);
    }
  }
  while (total > CONFIG.MFI_MAX_WORDS && hi - lo > 0) {
    // 从离锚点更远的一侧裁剪，保持目标词居中
    if (hi - center >= center - lo) {
      total -= wordsOf(sentences[hi]);
      hi--;
    } else {
      total -= wordsOf(sentences[lo]);
      lo++;
    }
  }
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

  // 主旨三选一：正确项取篇内最具代表性的句子（最长句），干扰项取窗外相邻句——
  // 与原文相邻但未入篇，需要真正读过才能区分
  const correct = [...window].sort((a, b) => b.length - a.length)[0];
  const distractors: string[] = [];
  for (const i of [lo - 1, hi + 1, lo - 2, hi + 2]) {
    if (distractors.length >= 2) break;
    // 窗外下标必然未入篇；再按内容去重，避免与正确项或其他干扰项撞句
    if (i >= 0 && i < sentences.length) {
      const s = sentences[i];
      if (s !== correct && !distractors.includes(s)) distractors.push(s);
    }
  }
  if (distractors.length < 2) return { available: false, reason: 'comprehension_context_missing' };

  const choices = [correct, ...distractors];
  // Fisher-Yates 洗牌，记录正确项落点
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  const passage = window.join(' ');
  const targetWords = sliceOptions.targetWords ?? [{ wordId: 0, chunk, meaning: '' }];
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
    topicTerms: sliceOptions.topicTerms,
    targetWords: targetWords.map((target) => ({ wordId: target.wordId, text: target.chunk })),
  });
  if (!assessment.eligible) {
    const reason = assessment.issues[0] ?? 'empty_text';
    return { available: false, reason };
  }

  return { available: true, material: {
    passage,
    words: assessment.wordCount,
    options: choices,
    answerIndex: choices.indexOf(correct),
    targetChecks,
  } };
}
