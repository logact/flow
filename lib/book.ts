import { STOPWORDS } from './vocab-data';

// 大规模书籍分析器：单遍扫描，1000 页（~30-50 万 token）秒级完成。
// 相比初版的改进：
//  1. 词形归并（保守规则：仅当原形也真实出现在文中才合并，避免误并）
//  2. 专有名词识别（大写占比 > 80% 且出现 >= 3 次 → 人名地名，从学习候选中剔除）
//  3. 覆盖率统计：全词表累计覆盖率曲线 + 结合用户已掌握词的"已知覆盖率"

export interface BookWordStat {
  word: string; // 展示形（最高频变体）
  lemma: string; // 归并键
  count: number; // 归并后的总频次
  perMillion: number; // 每百万词频次
  isProper: boolean;
  sentences: string[]; // 至多 3 条例句（取最高频变体的首次出现句）
}

export interface BookAnalysis {
  totalTokens: number;
  totalSentences: number;
  uniqueWords: number;
  contentWords: number; // 内容词（去停用词、去专名）
  properNouns: number;
  coverageCurve: { top: number; ratio: number }[];
  knownCoverage: number | null; // 虚词+短词+已掌握词 的 token 覆盖占比
  words: BookWordStat[];
}

const TOKEN_RE = /[A-Za-z][A-Za-z'-]*/g;

// PDF/网页文本清洗：页面家具与排版噪声。
// 1. 页眉页脚——同一行短文本反复出现（≥4 次）即判定为页面家具剔除；
// 2. 目录点线（····）与项目符号（•）——压成空白，避免它们把多个碎片粘成伪句子
export function cleanBookText(text: string): string {
  const lines = text.split('\n');
  const counts = new Map<string, number>();
  for (const l of lines) {
    const k = l.trim().toLowerCase();
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return lines
    .filter((l) => {
      const k = l.trim().toLowerCase();
      return !(k && k.length < 80 && (counts.get(k) ?? 0) >= 4);
    })
    .join('\n')
    .replace(/·{2,}/g, ' ')
    .replace(/•/g, ' ');
}

// 句子级卫生：在清洗后的文本上切句，丢掉字母占比过低（页码/点线残渣）、
// 过短（标题、引用行）或过长的碎片——练习材料与 MFI 篇章共用这个口径
export function cleanSentences(text: string): string[] {
  return cleanBookText(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(/(?<![A-Za-z0-9])\d+(?![A-Za-z0-9])/g, ' ') // 独立数字 token：页码/章节号残渣
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((s) => {
      if (s.length === 0 || s.length > 300) return false;
      const wc = s.split(' ').length;
      if (wc < 4 || wc > 60) return false;
      const letters = (s.match(/[A-Za-z]/g) ?? []).length;
      return letters / s.length >= 0.6;
    });
}

export function analyzeBook(text: string, knownWords?: Set<string>): BookAnalysis {
  // 第一遍：全文本统计（词频/大小写/总词次/已知覆盖）。
  // 必须在全文本上统计，不能只在过滤后的句子上——长句被过滤会导致词频漏计。
  const freq = new Map<string, number>();
  const capHits = new Map<string, number>(); // 大写形式出现次数（专名启发式）
  let totalTokens = 0;
  let knownTokens = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const w = raw.toLowerCase().replace(/^[-']+|[-']+$/g, '');
    if (w.length === 0) continue;
    totalTokens++;
    freq.set(w, (freq.get(w) ?? 0) + 1);
    if (/^[A-Z]/.test(raw)) capHits.set(w, (capHits.get(w) ?? 0) + 1);
    if (w.length < 4 || STOPWORDS.has(w) || knownWords?.has(w) === true) knownTokens++;
  }

  // 第二遍：只为内容词索引例句（至多 3 句），不参与统计。
  // 句子走清洗口径（页眉页脚/目录点线/低字母占比碎片剔除），否则 PDF 提取的
  // 排版噪声会直接变成练习材料
  const sentences = cleanSentences(text);
  const sentIdx = new Map<string, number[]>();
  sentences.forEach((sent, si) => {
    for (const m of sent.matchAll(TOKEN_RE)) {
      const w = m[0].toLowerCase().replace(/^[-']+|[-']+$/g, '');
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      const arr = sentIdx.get(w);
      if (!arr) sentIdx.set(w, [si]);
      else if (arr.length < 3 && arr[arr.length - 1] !== si) arr.push(si);
    }
  });

  // 保守词形归并：候选原形必须也真实出现在文中（freq.has），否则不动。
  // 这是原型级近似；正式版应换 wink-lemmatizer / WordNet 词元表。
  const lemmaOf = (w: string): string => {
    const has = (c: string) => c.length >= 3 && freq.has(c);
    if (w.endsWith('ies') && has(w.slice(0, -3) + 'y')) return w.slice(0, -3) + 'y';
    if (w.endsWith('ing')) {
      if (has(w.slice(0, -3))) return w.slice(0, -3);
      if (has(w.slice(0, -3) + 'e')) return w.slice(0, -3) + 'e';
    }
    if (w.endsWith('ed')) {
      if (has(w.slice(0, -2))) return w.slice(0, -2);
      if (has(w.slice(0, -1))) return w.slice(0, -1);
      if (has(w.slice(0, -2) + 'e')) return w.slice(0, -2) + 'e';
    }
    if (w.endsWith('es') && has(w.slice(0, -2))) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss') && has(w.slice(0, -1))) return w.slice(0, -1);
    return w;
  };

  const merged = new Map<string, { count: number; variants: Map<string, number> }>();
  for (const [w, c] of freq) {
    const lemma = lemmaOf(w);
    let entry = merged.get(lemma);
    if (!entry) {
      entry = { count: 0, variants: new Map() };
      merged.set(lemma, entry);
    }
    entry.count += c;
    entry.variants.set(w, (entry.variants.get(w) ?? 0) + c);
  }

  const words: BookWordStat[] = [];
  for (const [lemma, e] of merged) {
    if (lemma.length < 4 || STOPWORDS.has(lemma)) continue;
    const bestVariant = [...e.variants.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const capRatio = (capHits.get(bestVariant) ?? 0) / e.count;
    words.push({
      word: bestVariant,
      lemma,
      count: e.count,
      perMillion: Math.round((e.count / totalTokens) * 1e6),
      isProper: e.count >= 3 && capRatio > 0.8,
      sentences: (sentIdx.get(bestVariant) ?? []).map((i) => sentences[i]),
    });
  }
  words.sort((a, b) => b.count - a.count);

  // 全词表（含虚词）累计覆盖率曲线：前 N 高频词覆盖了多少 token
  const sortedCounts = [...freq.values()].sort((a, b) => b - a);
  const coverageCurve = [50, 100, 300, 1000, 3000].map((top) => ({
    top,
    ratio: Math.round((sortedCounts.slice(0, top).reduce((s, c) => s + c, 0) / totalTokens) * 1000) / 1000,
  }));

  return {
    totalTokens,
    totalSentences: sentences.length,
    uniqueWords: freq.size,
    contentWords: words.filter((w) => !w.isProper).length,
    properNouns: words.filter((w) => w.isProper).length,
    coverageCurve,
    knownCoverage: knownWords
      ? Math.round((knownTokens / totalTokens) * 1000) / 1000
      : null,
    words,
  };
}
