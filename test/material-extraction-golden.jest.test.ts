/// <reference types="jest" />

/**
 * 材料解析的黄金标准测试：固定测试 PDF + 人工核对的期望词表，断言解析偏差为零。
 *
 * 夹具 data/test-materials/known-words.pdf 由 scripts/generate-known-words-fixture.mjs
 * 生成（pdfkit 逐字符排版、不做断词，源文本即提取正确性的 ground truth）。
 *
 * 期望词表 GOLDEN_LEMMA_COUNTS 从夹具源文本逐词人工核对得出：
 * 49 个词元（数字 42 按分词规则忽略）→ 36 个 lemma。
 * 已知基线：wink-lemmatizer 将 discuss 归并为 discus（-ss 结尾的已知怪癖），
 * 该值经人工判定后作为基线记录在案；pdfjs 或 lemmatizer 升级引入偏差时本测试报警。
 *
 * 比对范围是解析层（提取 + 分词 + lemma 归并）；义项消歧属于独立关注点，
 * 因此 lemma 计数跨义项合并，不断言知识点 ID 形态。
 */

import { readFileSync } from 'node:fs';
import { importMaterialUseCase } from '../lib/application/material-import';
import type { AnalyzedMaterialAnalysis, MaterialRepository } from '../lib/application/ports';
import { extractTextFromFile } from '../lib/application/text-extraction';
import { extractMaterialTerms } from '../lib/domain/functions';
import type { Material } from '../lib/domain/model';
import { PAGE_1, PAGE_2 } from '../scripts/generate-known-words-fixture.mjs';

const FIXTURE = 'data/test-materials/known-words.pdf';
const at = '2026-11-12T00:20:00.000Z';

/** 人工核对的期望：lemma → 出现次数（源自 PAGE_1 + PAGE_2 共 49 个词元）。 */
const GOLDEN_LEMMA_COUNTS: Record<string, number> = {
  every: 4,
  the: 4,
  and: 3,
  run: 3, // runs / ran / Running
  team: 3, // team ×2 / teams
  tool: 2, // tools / tool
  a: 1,
  adjust: 1,
  be: 1, // are
  build: 1,
  change: 1,
  character: 1,
  company: 1,
  day: 1,
  discus: 1, // 已知怪癖：discuss 被 wink-lemmatizer 归并为 discus
  from: 1,
  he: 1,
  its: 1,
  keep: 1,
  learn: 1,
  meet: 1,
  morning: 1,
  move: 1, // moving
  openly: 1,
  plan: 1,
  problem: 1,
  project: 1,
  resilient: 1,
  setback: 1,
  she: 1,
  small: 1,
  useful: 1,
  week: 1,
  well: 1,
  work: 1,
  yesterday: 1,
};

const GOLDEN_TOKEN_TOTAL = 49;

/** 按解析层的同一分词规则取词序列（不做 lemma，验证提取保真度）。 */
function tokenize(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? [];
}

interface Deviation {
  missing: string[];
  extra: string[];
  countMismatch: string[];
}

/** 实际 lemma 计数与期望词表的三类偏差。 */
function diffLemmaCounts(actual: Map<string, number>): Deviation {
  const missing: string[] = [];
  const extra: string[] = [];
  const countMismatch: string[] = [];
  for (const [lemma, expected] of Object.entries(GOLDEN_LEMMA_COUNTS)) {
    const got = actual.get(lemma);
    if (got === undefined) missing.push(lemma);
    else if (got !== expected) countMismatch.push(`${lemma}: 期望 ${expected} 次，实际 ${got} 次`);
  }
  for (const lemma of actual.keys()) {
    if (!(lemma in GOLDEN_LEMMA_COUNTS)) extra.push(lemma);
  }
  return { missing, extra, countMismatch };
}

function expectNoDeviation(deviation: Deviation) {
  const lines = [
    ...deviation.missing.map((lemma) => `缺失: ${lemma}`),
    ...deviation.extra.map((lemma) => `多余: ${lemma}`),
    ...deviation.countMismatch,
  ];
  expect(lines).toEqual([]);
}

describe('材料解析黄金标准（known-words.pdf）', () => {
  test('文本提取保真：提取词序列与源文本逐词一致（0 偏差）', async () => {
    const extracted = await extractTextFromFile('pdf', readFileSync(FIXTURE));

    // 空白与分页差异归一化后，提取文本的每个词必须来自源文本且顺序一致。
    const expectedTokens = tokenize(`${PAGE_1}\n${PAGE_2}`);
    const actualTokens = tokenize(extracted.text);
    expect(actualTokens).toEqual(expectedTokens);
    // 数字 42 按分词规则被忽略，总数 49。
    expect(actualTokens).toHaveLength(GOLDEN_TOKEN_TOTAL);
    expect(extracted.metadata).toEqual(expect.objectContaining({ pageCount: 2, pagesWithoutText: [] }));
  });

  test('序数上标碎片 st/nd/rd/th 在分词层直接丢弃', () => {
    // PDF 把 1st/2nd/3rd/4th 的上标拆成独立 token；这些不是真实用词，不应成为 lemma。
    const material = {
      extractedText: 'Take the 1 st step, then the 2 nd and 3 rd floors, on the 4 th day.',
    } as unknown as Material;
    const lemmas = extractMaterialTerms(material).map((term) => term.lemma);
    expect(lemmas).not.toContain('st');
    expect(lemmas).not.toContain('nd');
    expect(lemmas).not.toContain('rd');
    expect(lemmas).not.toContain('th');
    // 包含这些字母组合的正常词不受影响。
    expect(lemmas).toContain('step');
    expect(lemmas).toContain('floor');
    expect(lemmas).toContain('day');
  });

  test('完整 S04 链路：lemma 归并与计数和人工核对词表零偏差', async () => {
    const saves: Array<{ material: unknown; analysis: AnalyzedMaterialAnalysis }> = [];
    const repository: MaterialRepository = {
      async saveMaterialWithAnalysis(material, analysis) {
        saves.push({ material, analysis });
      },
    };

    const result = await importMaterialUseCase(
      { repository },
      {
        materialId: 'material-known-words',
        analysisId: 'analysis-known-words',
        learnerId: 'learner-golden',
        filename: 'known-words.pdf',
        rawFile: readFileSync(FIXTURE),
        analyzerVersion: 'material-analyzer-v1',
        now: at,
      },
    );
    if (!result.ok) throw new Error(`黄金标准导入失败: ${result.reason}`);

    // 跨义项合并计数：解析层断言不依赖义项归属策略，直接从术语提取结果取 lemma 计数。
    const counts = new Map<string, number>();
    for (const term of extractMaterialTerms(result.material)) {
      counts.set(term.lemma, (counts.get(term.lemma) ?? 0) + term.occurrences.length);
    }

    const deviation = diffLemmaCounts(counts);
    if (deviation.missing.length || deviation.extra.length || deviation.countMismatch.length) {
      console.log('解析偏差报告:', JSON.stringify(deviation, null, 2));
    }
    expectNoDeviation(deviation);
    expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(GOLDEN_TOKEN_TOTAL);
    expect(saves).toHaveLength(1);
  });
});
