/// <reference types="jest" />

/**
 * S04 词义消歧 Live 评估：用真实 LLM 供应商逐条打印消歧结果并统计 gold set 准确率。
 * 需要环境变量 LLM_API_KEY（以及可选的 LLM_BASE_URL / LLM_MODEL）：
 *
 *   LLM_API_KEY=xxx npx jest --runInBand test/wsd-eval.live.test.ts
 *
 * gold set（data/gold/wsd-sample.json）每行：
 *   { "lemma": "...", "sentence": "...", "context": [], "senseId": "wn31:..." }
 * senseId 置 null 表示只观察结果、不参与计分，适合临时粘入自己的句子。
 * 未配置 key 时整个套件跳过。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSenseInventoryFromFile } from '../lib/application/sense-inventory';
import { createSenseDisambiguatorFromEnv } from '../lib/application/sense-disambiguator';
import type { SenseDisambiguationItem } from '../lib/application/ports';

const describeLive = process.env.LLM_API_KEY ? describe : describe.skip;

interface GoldEntry {
  lemma: string;
  sentence: string;
  context: string[];
  /** 人工标注的期望义项；null 表示只观察、不计分。 */
  senseId: string | null;
}

describeLive('S04 词义消歧（Live：真实 LLM 供应商）', () => {
  jest.setTimeout(180_000);

  test('逐条打印消歧结果并统计 gold set 准确率', async () => {
    const root = join(__dirname, '..');
    const gold = JSON.parse(
      readFileSync(join(root, 'data', 'gold', 'wsd-sample.json'), 'utf8'),
    ) as GoldEntry[];
    const inventory = loadSenseInventoryFromFile(join(root, 'data', 'sense-inventory-v1.json'));
    const disambiguator = createSenseDisambiguatorFromEnv();

    const items: SenseDisambiguationItem[] = gold.map((entry, index) => {
      const candidates = inventory.lookup(entry.lemma);
      if (candidates.length < 2) {
        throw new Error(`gold entry ${index}（${entry.lemma}）需要至少两个候选义项才有评估意义`);
      }
      return {
        key: String(index),
        lemma: entry.lemma,
        sentence: entry.sentence,
        context: entry.context,
        candidates,
      };
    });

    const picks = await disambiguator.disambiguate(items);
    const glossById = new Map(
      items.flatMap((item) => item.candidates.map((candidate) => [candidate.id, candidate.gloss] as const)),
    );

    const misses: string[] = [];
    let labeled = 0;
    let correct = 0;

    gold.forEach((entry, index) => {
      const pick = picks.find((candidate) => candidate.key === String(index));
      const chosen = pick?.senseId ?? '(无返回)';
      const gloss = pick ? glossById.get(pick.senseId) ?? '(未知义项)' : '';
      let mark = '?';
      if (entry.senseId !== null) {
        labeled += 1;
        if (pick?.senseId === entry.senseId) {
          correct += 1;
          mark = '✓';
        } else {
          mark = '✗';
          misses.push(`${entry.lemma}: 期望 ${entry.senseId}，实际 ${chosen}`);
        }
      }
      console.log(`${mark} ${entry.lemma} | ${entry.sentence} → ${chosen}${gloss ? ` (${gloss})` : ''}`);
    });

    if (labeled > 0) {
      console.log(`WSD 准确率: ${correct}/${labeled} (${(correct / labeled * 100).toFixed(1)}%)`);
    } else {
      console.log('gold set 全部未标注，仅打印消歧结果。');
    }
    if (misses.length > 0) console.log(`错分明细:\n${misses.join('\n')}`);
    if (labeled > 0) expect(correct / labeled).toBeGreaterThanOrEqual(0.9);
  });
});
