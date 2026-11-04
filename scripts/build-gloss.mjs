// 本地词典构建：从 ECDICT 全量 CSV 筛出高频词子集 → data/gloss-zh.tsv
// 用法：node scripts/build-gloss.mjs /path/to/ecdict.csv
// 词典来源：https://github.com/skywind3000/ECDICT （开源免费，见仓库 LICENSE）
import fs from 'node:fs';

const src = process.argv[2] ?? '/tmp/ecdict.csv';
const TOP_N = Number(process.argv[3] ?? 60_000);

// RFC4180 解析：translation 字段内含逗号与换行，必须按引号状态机切
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// 释义压缩：去掉 [网络]/[口语] 等非正式行，剩余行空格连接，截断 120 字符
function compact(translation) {
  const lines = translation
    .split('\\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('['));
  return lines.join(' ').replace(/[\r\s]+/g, ' ').slice(0, 120);
}

console.log(`读取 ${src} …`);
const rows = parseCsv(fs.readFileSync(src, 'utf8'));
console.log(`总词条 ${rows.length - 1}`);

const candidates = [];
for (const r of rows.slice(1)) {
  const [word, , , translation, , , , tag, bnc, frq] = r;
  if (!word || !translation) continue;
  if (!/^[a-z][a-z'-]*$/.test(word)) continue; // 只要小写单词（专名/缩写/短语跳过）
  const b = Number(bnc) || Infinity;
  const f = Number(frq) || Infinity;
  const rank = Math.min(b, f);
  if (rank === Infinity && !tag) continue; // 无词频排名且无考试标签 → 生僻词
  const gloss = compact(translation);
  if (!gloss) continue;
  candidates.push({ word, gloss, rank, tag: tag ? 1 : 0 });
}

candidates.sort((a, b) => a.rank - b.rank || b.tag - a.tag || a.word.localeCompare(b.word));
const picked = candidates.slice(0, TOP_N);

fs.mkdirSync('data', { recursive: true });
const header = `# 本地英汉词典子集 · 来源 ECDICT (https://github.com/skywind3000/ECDICT)\n# 筛选：小写单词 + BNC/COCA 词频前 ${TOP_N}（含四六级/考研/托福/雅思/GRE 标签词）\n`;
fs.writeFileSync(
  'data/gloss-zh.tsv',
  header + [...picked].sort((a, b) => a.word.localeCompare(b.word)).map((p) => `${p.word}\t${p.gloss}`).join('\n') + '\n'
);
// 频率序词表（一行一词，行号即排名）：vocab_estimate → top-N 假定已知的底座资源
// （MFI 已知覆盖率、按差距选材、已知词高位播种共用）
fs.writeFileSync('data/word-rank.txt', picked.map((p) => p.word).join('\n') + '\n');
const size = fs.statSync('data/gloss-zh.tsv').size;
console.log(`✔ data/gloss-zh.tsv：${picked.length} 词，${(size / 1048576).toFixed(1)} MB`);
console.log(`✔ data/word-rank.txt：${picked.length} 词（频率降序）`);
