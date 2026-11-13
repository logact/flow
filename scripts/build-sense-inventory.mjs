#!/usr/bin/env node
/**
 * 从 wordnet-db（Princeton WordNet 3.1 dict 文件）构建 data/sense-inventory-v1.json。
 *
 * 词条范围限定为 BNC/COCA 词族成员（含 headword 与 members，均转小写）：
 * 分析器只对这些 lemma 查库，过滤用于控制产物体积。
 *
 * 用法：node scripts/build-sense-inventory.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORDNET_DIR = join(root, 'node_modules', 'wordnet-db', 'dict');
const WORD_LIST = join(root, 'data', 'bnc-coca-l6-v2.0.0.json');
const OUTPUT = join(root, 'data', 'sense-inventory-v1.json');

const POS_FILES = ['adj', 'adv', 'noun', 'verb'];
const POS_NAME = { a: 'adjective', s: 'adjective', r: 'adverb', n: 'noun', v: 'verb' };
/** 分析器的分词正则只产出字母串，多词词条（含下划线/连字符/空格）永远不会被查到。 */
const LOOKUP_ABLE = /^[\p{L}.'’]+$/u;

function loadGlossMap(pos) {
  const map = new Map();
  for (const line of readFileSync(join(WORDNET_DIR, `data.${pos}`), 'utf8').split('\n')) {
    if (!line || line.startsWith('  ')) continue;
    const bar = line.indexOf(' | ');
    if (bar === -1) continue;
    const offset = line.slice(0, bar).split(/\s+/)[0];
    // 只保留义项主释义，去掉 WordNet 例句，控制产物体积。
    const gloss = line.slice(bar + 3).split(';')[0].trim();
    map.set(offset, gloss);
  }
  return map;
}

function collectWantedLemmas() {
  const list = JSON.parse(readFileSync(WORD_LIST, 'utf8'));
  const wanted = new Set();
  for (const family of list.families) {
    wanted.add(String(family.headword).toLocaleLowerCase('en'));
    for (const member of family.members) wanted.add(String(member).toLocaleLowerCase('en'));
  }
  return wanted;
}

const wanted = collectWantedLemmas();
const glossMaps = Object.fromEntries(POS_FILES.map((pos) => [pos, loadGlossMap(pos)]));

const senses = [];
for (const pos of POS_FILES) {
  for (const line of readFileSync(join(WORDNET_DIR, `index.${pos}`), 'utf8').split('\n')) {
    if (!line || line.startsWith('  ')) continue;
    const fields = line.split(/\s+/);
    const lemma = fields[0];
    if (!wanted.has(lemma) || !LOOKUP_ABLE.test(lemma)) continue;
    const pointerCount = Number(fields[3]);
    const senseCount = Number(fields[4 + pointerCount]);
    const offsets = fields.slice(6 + pointerCount, 6 + pointerCount + senseCount);
    const posLetter = fields[1];
    for (const offset of offsets) {
      const gloss = glossMaps[pos].get(offset);
      if (!gloss) continue;
      senses.push([`wn31:${posLetter}:${offset}`, lemma, POS_NAME[posLetter] ?? posLetter, gloss]);
    }
  }
}

senses.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const inventory = {
  version: '1.0.0',
  source: { name: 'princeton-wordnet', version: '3.1', via: 'wordnet-db' },
  senses,
};
writeFileSync(OUTPUT, `${JSON.stringify(inventory)}\n`);
console.error(`lemmas in word list: ${wanted.size}`);
console.error(`sense entries: ${senses.length}`);
console.error(`written: ${OUTPUT}`);
