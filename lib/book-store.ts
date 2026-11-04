import type Database from 'better-sqlite3';
import { analyzeBook } from './book';

// 落库时为例句存储设上限：排名 5000 以后的词（多为罕见词）不存例句
const SENTENCE_STORAGE_LIMIT = 5000;

export interface PersistedBook {
  sourceId: number;
  title: string;
  durationMs: number;
  totalTokens: number;
  totalSentences: number;
  uniqueWords: number;
  contentWords: number;
  properNouns: number;
  coverageCurve: { top: number; ratio: number }[];
  knownCoverage: number | null;
  topWords: { word: string; count: number; perMillion: number; isProper: boolean }[];
}

// 分析文本并把结果落库（book_sources + book_words），供 txt 粘贴、txt 上传、
// PDF 任务三种入口共用。原文与摘要一并存储，便于后续重新选材。
export function persistBookAnalysis(
  db: Database.Database,
  title: string,
  text: string
): PersistedBook {
  // 已知覆盖率：F ≥ 75（待集成及以上档位）的词视为"认识"
  const known = new Set(
    (
      db
        .prepare(`SELECT chunk FROM words WHERE fluency >= 75`)
        .all() as { chunk: string }[]
    ).map((r) => r.chunk.toLowerCase())
  );

  const t0 = Date.now();
  const analysis = analyzeBook(text, known);

  const summary: Omit<PersistedBook, 'sourceId'> = {
    title,
    durationMs: Date.now() - t0,
    totalTokens: analysis.totalTokens,
    totalSentences: analysis.totalSentences,
    uniqueWords: analysis.uniqueWords,
    contentWords: analysis.contentWords,
    properNouns: analysis.properNouns,
    coverageCurve: analysis.coverageCurve,
    knownCoverage: analysis.knownCoverage,
    topWords: analysis.words.slice(0, 50),
  };

  const insertSource = db.prepare(
    `INSERT INTO book_sources (title, total_tokens, total_sentences, text, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertWord = db.prepare(
    `INSERT INTO book_words (source_id, word, freq, per_million, is_proper, sentences)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const sourceId = db.transaction(() => {
    const id = Number(
      insertSource.run(
        title,
        analysis.totalTokens,
        analysis.totalSentences,
        text,
        JSON.stringify({ ...summary, topWords: undefined }),
        Date.now()
      ).lastInsertRowid
    );
    analysis.words.forEach((w, i) => {
      insertWord.run(
        id,
        w.word,
        w.count,
        w.perMillion,
        w.isProper ? 1 : 0,
        i < SENTENCE_STORAGE_LIMIT ? JSON.stringify(w.sentences) : '[]'
      );
    });
    return id;
  })();

  return { sourceId, ...summary };
}
