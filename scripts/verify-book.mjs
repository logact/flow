// 大规模书籍导入验证：真实书籍（Moby Dick，~21.5 万词）的分析性能与选材正确性
// 用法：BOOK_FILE=/tmp/moby.txt node scripts/verify-book.mjs
import { readFileSync } from 'node:fs';

const base = process.env.BASE || 'http://localhost:3000';
const text = readFileSync(process.env.BOOK_FILE || '/tmp/moby.txt', 'utf8');
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  OK  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
};
const j = async (r) => {
  if (!r.ok) throw new Error(`${r.url} -> ${r.status}`);
  return r.json();
};
const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);

console.log(`--- 分析大书（原始文本 ${(text.length / 1024 / 1024).toFixed(2)} MB） ---`);
const a = await post('/api/books', { title: 'Moby Dick', text });
console.log(
  `  耗时 ${(a.durationMs / 1000).toFixed(2)}s ｜ tokens=${a.totalTokens.toLocaleString()} ｜ 独立词=${a.uniqueWords.toLocaleString()} ｜ 内容词=${a.contentWords.toLocaleString()} ｜ 专名=${a.properNouns.toLocaleString()}`
);
console.log(
  `  覆盖率曲线: ${a.coverageCurve.map((c) => `前${c.top}=${(c.ratio * 100).toFixed(1)}%`).join(' · ')} ｜ 已知覆盖率=${a.knownCoverage != null ? (a.knownCoverage * 100).toFixed(1) + '%' : 'n/a'}`
);
check(a.totalTokens > 180000, `总词次 > 18 万，实际 ${a.totalTokens}`);
check(a.contentWords > 3000, `内容词 > 3000，实际 ${a.contentWords}`);
check(a.durationMs < 10000, `分析耗时 < 10s，实际 ${(a.durationMs / 1000).toFixed(2)}s`);

const whale = a.topWords.find((w) => w.word === 'whale');
check(whale && !whale.isProper && whale.count > 300, `whale 是高频内容词（${whale?.count} 次，专名=${whale?.isProper}）`);
const ahab = a.topWords.find((w) => w.word === 'ahab');
check(ahab && ahab.isProper, `ahab 被识别为专有名词并从学习候选剔除（${ahab?.count} 次）`);
console.log(
  `  Top10: ${a.topWords.slice(0, 10).map((w) => `${w.word}${w.isProper ? '(专)' : ''}:${w.count}`).join(' ')}`
);

console.log('--- 从书源导入 30 词为目标 ---');
const g = await post('/api/goals', { type: 'book', title: 'Moby Dick', sourceId: a.sourceId, count: 30 });
check(g.added === 30, `精确导入 30 词（专名/重复已排除），实际 ${g.added}`);

const snap = await (await fetch(`${base}/api/task`, { cache: 'no-store' })).json();
const mobyWords = snap.words.filter((w) => w.scene.includes('Moby Dick'));
check(mobyWords.length === 30, `调度器接管 30 个书源语块，实际 ${mobyWords.length}`);
check(
  mobyWords.every((w) => w.step3_sentence.includes('___')) &&
    mobyWords.every((w) => w.step4_sentences[0].toLowerCase().includes(w.chunk)),
  '全部语块带原句挖空 Step3 + 原句 Step4'
);
const { sources } = await (await fetch(`${base}/api/books`, { cache: 'no-store' })).json();
check(sources.length >= 1 && sources[0].title === 'Moby Dick', `书源列表可查询（${sources.length} 个）`);

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 个断言失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
