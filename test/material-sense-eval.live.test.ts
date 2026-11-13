/// <reference types="jest" />

/**
 * S04 端到端 lemma+sense golden 评估：对真实材料跑完整分析管线
 * （解析 → 词表过滤 → 词义库 → AI 采样投票），与人工标注的 golden set 比对。
 * 需要环境变量 LLM_API_KEY（以及可选 LLM_BASE_URL / LLM_MODEL）：
 *
 *   LLM_API_KEY=xxx npx jest --runInBand --testMatch '<glob 指向本文件>'
 *
 * golden set（data/gold/material-sense.json）：
 * - expectSense：lemma 在材料内应有的唯一义项；expectedSenseId 为 null 表示
 *   义项混合/候选过近，只观察打印、不计分。
 * - expectExcluded：lemma 不应生成知识点，reason 记录被哪道闸门拦下。
 * 未配置 key 时整个套件跳过。整份材料约 57 次 AI 调用、两分钟以内。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSenseAssignments } from '../lib/application/material-sense-resolution';
import { createSenseDisambiguatorFromEnv } from '../lib/application/sense-disambiguator';
import { loadSenseInventoryFromFile } from '../lib/application/sense-inventory';
import { extractTextFromFile } from '../lib/application/text-extraction';
import { createVocabularyDecisionFilter, loadVocabularyIndexFromFile } from '../lib/application/vocabulary-index';
import { extractMaterialTerms } from '../lib/domain/functions';
import { silentLogger } from './helpers/silent-logger';

const describeLive = process.env.LLM_API_KEY ? describe : describe.skip;

interface GoldEntry {
  lemma: string;
  expectedSenseId: string | null;
  note: string;
}

interface GoldFile {
  source: string;
  description: string;
  expectSense: GoldEntry[];
  expectExcluded: { lemma: string; reason: string }[];
}

describeLive('S04 端到端 lemma+sense golden（Live：真实材料 + 真实 LLM）', () => {
  jest.setTimeout(300_000);

  test('完整管线输出与人工标注比对', async () => {
    const root = join(__dirname, '..');
    const gold = JSON.parse(
      readFileSync(join(root, 'data', 'gold', 'material-sense.json'), 'utf8'),
    ) as GoldFile;

    const data = readFileSync(join(root, gold.source));
    const extracted = await extractTextFromFile('pdf', data);
    const material = {
      id: 'golden-eval',
      learnerId: 'golden-eval',
      title: gold.source,
      filename: gold.source,
      format: 'pdf' as const,
      mimeType: 'application/pdf',
      checksum: 'golden-eval',
      storageKey: null,
      extractedText: extracted.text,
      extractionMetadata: extracted.metadata,
      createdAt: '2026-11-13T00:00:00.000Z',
    };
    const terms = extractMaterialTerms(material);
    const vocabularyDecisionFilter = createVocabularyDecisionFilter(
      loadVocabularyIndexFromFile(join(root, 'data', 'bnc-coca-l6-v2.0.0.json')),
    );
    const senseInventory = loadSenseInventoryFromFile(join(root, 'data', 'sense-inventory-v1.json'));

    const { assignments, excluded } = await resolveSenseAssignments(terms, {
      senseInventory,
      senseDisambiguator: createSenseDisambiguatorFromEnv(process.env, silentLogger, silentLogger),
      vocabularyFilter: vocabularyDecisionFilter,
      logger: silentLogger,
    });
    const assignmentByLemma = new Map(assignments.map((assignment) => [assignment.lemma, assignment]));
    const excludedByLemma = new Map(excluded.map((entry) => [entry.lemma, entry]));

    const misses: string[] = [];
    const exclusionMisses: string[] = [];
    let labeled = 0;
    let correct = 0;

    console.log('--- expectSense ---');
    for (const entry of gold.expectSense) {
      const assignment = assignmentByLemma.get(entry.lemma);
      const chosen = assignment?.senseId ?? '(未生成知识点)';
      const gloss = assignment?.definition ?? '';
      let mark = '?';
      if (entry.expectedSenseId !== null) {
        labeled += 1;
        if (assignment?.senseId === entry.expectedSenseId) {
          correct += 1;
          mark = '✓';
        } else {
          mark = '✗';
          misses.push(`${entry.lemma}: 期望 ${entry.expectedSenseId}，实际 ${chosen}`);
        }
      }
      console.log(`${mark} ${entry.lemma} → ${chosen}${gloss ? ` (${gloss})` : ''}｜${entry.note}`);
    }

    console.log('--- expectExcluded ---');
    for (const expectation of gold.expectExcluded) {
      const leaked = assignmentByLemma.get(expectation.lemma);
      const exclusion = excludedByLemma.get(expectation.lemma);
      // 序号碎片在解析层就被丢弃，永远不会成为 term，只断言它不出现在任何输出里
      const reasonOk = expectation.reason === 'ordinal-fragment'
        ? exclusion === undefined
        : exclusion?.reason === expectation.reason;
      const ok = !leaked && reasonOk;
      console.log(`${ok ? '✓' : '✗'} ${expectation.lemma} 未生成知识点（${expectation.reason}）`
        + `${exclusion ? `，已记录排除原因 "${exclusion.reason}"（${exclusion.occurrences.length} 次出现）` : ''}`
        + `${leaked ? `，实际漏出 ${leaked.senseId}` : ''}`
        + `${!leaked && !reasonOk ? `，排除原因不符：${exclusion ? `实际 "${exclusion.reason}"` : '未记录'}` : ''}`);
      if (leaked) exclusionMisses.push(`${expectation.lemma}: 期望被 ${expectation.reason} 拦截，实际生成 ${leaked.senseId}`);
      if (!leaked && !reasonOk) exclusionMisses.push(`${expectation.lemma}: 期望排除原因 ${expectation.reason}，${exclusion ? `实际 ${exclusion.reason}` : '未记录'}`);
    }

    if (labeled > 0) {
      console.log(`golden 义项准确率: ${correct}/${labeled} (${(correct / labeled * 100).toFixed(1)}%)`);
    }
    if (misses.length > 0) console.log(`错分明细:\n${misses.join('\n')}`);
    // 义项判定依赖 AI，允许 10% 抖动（与 wsd-eval 一致）；拦截类断言是确定性的，必须全过。
    if (labeled > 0) expect(correct / labeled).toBeGreaterThanOrEqual(0.9);
    expect(exclusionMisses).toEqual([]);
  });
});
