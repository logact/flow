/// <reference types="jest" />

/**
 * 打印 S04 词义消歧真实发给 AI 的完整 prompt（无需 API key）。
 * 内容与 createHttpSenseDisambiguator 实际发送的 user message 完全一致，
 * 用于人工检查 prompt 结构与候选义项呈现，调整 prompt 时先跑它。
 *
 *   npm run logs:s4:prompt
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSenseInventoryFromFile } from '../lib/application/sense-inventory';
import { buildDisambiguationPrompt } from '../lib/application/sense-disambiguator';
import type { SenseDisambiguationItem } from '../lib/application/ports';

interface GoldEntry {
  lemma: string;
  sentence: string;
  context: string[];
  senseId: string | null;
}

test('打印发送给 AI 的完整词义消歧 prompt', () => {
  const root = join(__dirname, '..');
  const gold = JSON.parse(
    readFileSync(join(root, 'data', 'gold', 'wsd-sample.json'), 'utf8'),
  ) as GoldEntry[];
  const inventory = loadSenseInventoryFromFile(join(root, 'data', 'sense-inventory-v1.json'));

  const items: SenseDisambiguationItem[] = gold.map((entry, index) => {
    const candidates = inventory.lookup(entry.lemma);
    if (candidates.length < 2) throw new Error(`gold entry ${index}（${entry.lemma}）候选义项不足`);
    return {
      key: String(index),
      lemma: entry.lemma,
      sentence: entry.sentence,
      context: entry.context,
      candidates,
    };
  });

  const prompt = buildDisambiguationPrompt(items);
  console.log(`===== 词义消歧 prompt（${items.length} 处出现，一次发送）=====\n${prompt}\n===== prompt 结束 =====`);

  expect(prompt).toContain('Return only a JSON array');
  expect(prompt).toContain('"senseId"');
  expect(prompt).toContain('I run every morning before work.');
  expect(prompt).toContain('wn31:v:01930264');
  expect(prompt).toContain('wn31:a:01340892');
});
