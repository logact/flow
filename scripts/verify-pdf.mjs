// PDF 上传（文字层 + 扫描件 OCR）端到端验证
import { readFileSync } from 'node:fs';

const base = process.env.BASE || 'http://localhost:3000';
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

async function uploadAndWait(filePath, title, timeoutMs) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)], { type: 'application/pdf' }), filePath.split('/').pop());
  form.append('title', title);
  const { jobId } = await j(await fetch(`${base}/api/books/upload`, { method: 'POST', body: form }));
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const { job } = await j(await fetch(`${base}/api/books/jobs?id=${jobId}`, { cache: 'no-store' }));
    if (job.status !== 'processing') return { job, elapsed: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`${title}: 超时（${timeoutMs / 1000}s）仍未完成`);
  }
}

console.log('--- 文字层 PDF ---');
const t = await uploadAndWait('/tmp/flow-test-text.pdf', 'Test Text PDF', 60_000);
console.log(
  `  ${(t.elapsed / 1000).toFixed(1)}s ｜ ${t.job.processed_pages}/${t.job.total_pages} 页 ｜ OCR ${t.job.ocr_pages} 页 ｜ ${t.job.text_chars.toLocaleString()} 字符`
);
check(t.job.status === 'done', `任务完成（实际 ${t.job.status}${t.job.error ? ': ' + t.job.error : ''}）`);
check(t.job.ocr_pages === 0, `纯文字层，OCR 页数 = 0，实际 ${t.job.ocr_pages}`);
const sum1 = await j(await fetch(`${base}/api/books?id=${t.job.source_id}`, { cache: 'no-store' }));
check(
  sum1.topWords.some((w) => w.word === 'focus') && sum1.topWords.some((w) => w.word === 'attention'),
  `文字层提取正确：Top 词含 focus / attention`
);
check(sum1.totalTokens > 3000, `提取词次 > 3000，实际 ${sum1.totalTokens}`);

console.log('--- 扫描件 PDF（OCR） ---');
const s = await uploadAndWait('/tmp/flow-test-scan.pdf', 'Test Scan PDF', 300_000);
console.log(
  `  ${(s.elapsed / 1000).toFixed(1)}s ｜ ${s.job.processed_pages}/${s.job.total_pages} 页 ｜ OCR ${s.job.ocr_pages} 页 ｜ ${s.job.text_chars.toLocaleString()} 字符`
);
check(s.job.status === 'done', `任务完成（实际 ${s.job.status}${s.job.error ? ': ' + s.job.error : ''}）`);
check(s.job.ocr_pages === s.job.total_pages && s.job.total_pages > 0, `全部页面走 OCR，实际 ${s.job.ocr_pages}/${s.job.total_pages}`);
const sum2 = await j(await fetch(`${base}/api/books?id=${s.job.source_id}`, { cache: 'no-store' }));
check(
  sum2.topWords.some((w) => ['focus', 'attention', 'distraction', 'session'].includes(w.word)),
  `OCR 还原出目标内容词（Top50 命中：${sum2.topWords.filter((w) => ['focus', 'attention', 'distraction', 'session'].includes(w.word)).map((w) => w.word).join(', ') || '无'}）`
);

console.log('--- 从 OCR 书源导入 10 词 ---');
const g = await j(
  await fetch(`${base}/api/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'book', title: 'Test Scan PDF', sourceId: s.job.source_id, count: 10 }),
  })
);
check(g.added === 10, `OCR 书源精确导入 10 词，实际 ${g.added}`);

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 个断言失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
