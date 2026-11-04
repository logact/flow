// 修复存量书目标的练习材料：旧管道把 PDF 排版噪声（目录点线/页眉页脚/引用行）当例句入库。
// 用清洗后的句子管道重新索引每个书源，重建 book_words.sentences，
// 并为其下所有书目标重建 words 的 step3_sentence / step4_sentences。
// 用法：npx tsx scripts/repair-materials.mts   （会直接改写 flow.db，建议先备份）
import { createDb } from '../lib/db';
import { analyzeBook } from '../lib/book';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const db = createDb('flow.db');
const sources = db
  .prepare(`SELECT id, title, text FROM book_sources WHERE text IS NOT NULL`)
  .all() as { id: number; title: string; text: string }[];

for (const src of sources) {
  const analysis = analyzeBook(src.text);
  const byWord = new Map(analysis.words.map((w) => [w.word.toLowerCase(), w]));
  console.log(`\n=== ${src.title}（source ${src.id}）：清洗后句子 ${analysis.totalSentences} 条 ===`);

  // 1. 重建 book_words 例句（影响之后从同一书源再建的目标）
  const bwRows = db.prepare(`SELECT id, word FROM book_words WHERE source_id = ?`).all(src.id) as {
    id: number;
    word: string;
  }[];
  const upBw = db.prepare(`UPDATE book_words SET sentences = ? WHERE id = ?`);
  let bwFixed = 0;
  for (const r of bwRows) {
    const stat = byWord.get(r.word.toLowerCase());
    if (stat) {
      upBw.run(JSON.stringify(stat.sentences), r.id);
      bwFixed++;
    }
  }
  console.log(`  book_words 例句重建 ${bwFixed}/${bwRows.length}`);

  // 2. 重建引用该书源的目标下的词材料
  const goals = (
    db.prepare(`SELECT id, title, target FROM goals`).all() as {
      id: number;
      title: string;
      target: string | null;
    }[]
  ).filter((g) => {
    try {
      return g.target && JSON.parse(g.target).source_id === src.id;
    } catch {
      return false;
    }
  });
  for (const g of goals) {
    const words = db
      .prepare(`SELECT id, chunk, step3_sentence FROM words WHERE goal_id = ?`)
      .all(g.id) as { id: number; chunk: string; step3_sentence: string }[];
    const upW = db.prepare(`UPDATE words SET step3_sentence = ?, step4_sentences = ? WHERE id = ?`);
    let fixed = 0;
    for (const w of words) {
      const stat = byWord.get(w.chunk.toLowerCase());
      if (!stat || stat.sentences.length === 0) continue;
      const re = new RegExp(`\\b${escapeRegExp(stat.word)}\\b`, 'i');
      const step3Source = stat.sentences[1] ?? stat.sentences[0];
      upW.run(
        step3Source.replace(re, '___'),
        JSON.stringify(stat.sentences),
        w.id
      );
      fixed++;
      if (['writing', 'learning', 'reading'].includes(w.chunk)) {
        console.log(`  [${w.chunk}] 新 step3：${step3Source.replace(re, '___')}`);
      }
    }
    console.log(`  目标「${g.title}」：重建 ${fixed}/${words.length} 个词的练习材料`);
  }
}
db.close();
console.log('\n完成。');
