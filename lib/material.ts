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
