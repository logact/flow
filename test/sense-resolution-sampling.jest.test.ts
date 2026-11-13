/// <reference types="jest" />

/**
 * 词义归属的采样投票与词表过滤测试：
 * - 多义词只采样首现 + 均匀采样的出现记录发给 AI（默认 ≤3 条）。
 * - 按句判义后多数投票，该材料内一词一义，全部出现记录归入胜出义项。
 * - 平票取最早出现记录支持的义项；无效 senseId 不计票。
 * - 词表过滤为 false 的词不生成任何知识点（包括占位义项）。
 */

import type { MaterialTerm } from '../lib/domain/functions';
import type { Occurrence } from '../lib/domain/model';
import {
  PLACEHOLDER_SENSE_ID,
  resolveSenseAssignments,
  sampleOccurrenceIndexes,
} from '../lib/application/material-sense-resolution';
import {
  createVocabularyDecisionFilter,
  createVocabularyFilter,
  loadVocabularyIndexFromFile,
} from '../lib/application/vocabulary-index';
import type { InventorySense, SenseDisambiguationItem, SenseDisambiguator } from '../lib/application/ports';
import { silentLogger } from './helpers/silent-logger';

const SENSE_A: InventorySense = { id: 'wn31:v:001', pos: 'verb', gloss: 'sense A' };
const SENSE_B: InventorySense = { id: 'wn31:v:002', pos: 'verb', gloss: 'sense B' };
const SENSE_C: InventorySense = { id: 'wn31:v:003', pos: 'verb', gloss: 'sense C' };

function occurrence(sentence: string): Occurrence {
  return { rawForm: 'run', sentence, context: [] };
}

function term(lemma: string, occurrenceCount: number): MaterialTerm {
  return {
    lemma,
    occurrences: Array.from({ length: occurrenceCount }, (_, index) => occurrence(`Sentence ${index} with ${lemma}.`)),
  };
}

/** 记录收到的 items，并按 key 返回预设义项的消歧器。 */
function stubDisambiguator(
  picksByKey: Record<string, string>,
): SenseDisambiguator & { received: SenseDisambiguationItem[][] } {
  const received: SenseDisambiguationItem[][] = [];
  return {
    received,
    async disambiguate(items) {
      received.push(items);
      return items.map((item) => ({ key: item.key, senseId: picksByKey[item.key] }));
    },
  };
}

const inventory = { lookup: () => [SENSE_A, SENSE_B, SENSE_C] };

describe('sampleOccurrenceIndexes', () => {
  it('首现 + 均匀采样，总数不超过上限', () => {
    expect(sampleOccurrenceIndexes(6, 3)).toEqual([0, 3, 5]);
    expect(sampleOccurrenceIndexes(10, 3)).toEqual([0, 5, 9]);
    expect(sampleOccurrenceIndexes(3, 3)).toEqual([0, 1, 2]);
    expect(sampleOccurrenceIndexes(1, 3)).toEqual([0]);
    expect(sampleOccurrenceIndexes(6, 1)).toEqual([0]);
  });
});

describe('resolveSenseAssignments：采样投票', () => {
  it('6 处出现只采样 3 条发给 AI，全部出现归入胜义项', async () => {
    const disambiguator = stubDisambiguator({
      '0:0': SENSE_A.id,
      '0:3': SENSE_A.id,
      '0:5': SENSE_B.id,
    });
    const { assignments } = await resolveSenseAssignments(
      [term('run', 6)],
      { senseInventory: inventory, senseDisambiguator: disambiguator, logger: silentLogger },
    );
    expect(disambiguator.received[0].map((item) => item.key)).toEqual(['0:0', '0:3', '0:5']);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].senseId).toBe(SENSE_A.id);
    expect(assignments[0].occurrences).toHaveLength(6);
  });

  it('平票时取最早出现记录支持的义项', async () => {
    const disambiguator = stubDisambiguator({
      '0:0': SENSE_B.id,
      '0:5': SENSE_A.id,
    });
    const { assignments } = await resolveSenseAssignments(
      [term('run', 6)],
      {
        senseInventory: inventory,
        senseDisambiguator: disambiguator,
        logger: silentLogger,
        maxSamplesPerTerm: 2,
      },
    );
    expect(assignments[0].senseId).toBe(SENSE_B.id);
  });

  it('无效 senseId 不计入投票', async () => {
    const disambiguator = stubDisambiguator({
      '0:0': 'wn31:v:999',
      '0:3': SENSE_B.id,
      '0:5': SENSE_B.id,
    });
    const { assignments } = await resolveSenseAssignments(
      [term('run', 6)],
      { senseInventory: inventory, senseDisambiguator: disambiguator, logger: silentLogger },
    );
    expect(assignments[0].senseId).toBe(SENSE_B.id);
  });

  it('没有任何有效投票时整词回退占位义项', async () => {
    const disambiguator = stubDisambiguator({
      '0:0': 'wn31:v:999',
      '0:3': 'wn31:v:998',
      '0:5': 'wn31:v:997',
    });
    const { assignments } = await resolveSenseAssignments(
      [term('run', 6)],
      { senseInventory: inventory, senseDisambiguator: disambiguator, logger: silentLogger },
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0].senseId).toBe(PLACEHOLDER_SENSE_ID);
    expect(assignments[0].occurrences).toHaveLength(6);
  });
});

describe('resolveSenseAssignments：词表过滤', () => {
  it('过滤为 false 的词不生成知识点，其余词照常消歧', async () => {
    const disambiguator = stubDisambiguator({ '1:0': SENSE_A.id });
    const { assignments, excluded } = await resolveSenseAssignments(
      [term('the', 4), term('run', 2)],
      {
        senseInventory: inventory,
        senseDisambiguator: disambiguator,
        vocabularyFilter: (lemma) => lemma !== 'the',
        logger: silentLogger,
      },
    );
    expect(assignments.map((assignment) => assignment.lemma)).toEqual(['run']);
    expect(assignments[0].senseId).toBe(SENSE_A.id);
    // 布尔谓词没有原因信息，回退为通用原因，但词与出现记录仍然保留
    expect(excluded).toEqual([
      { lemma: 'the', reason: 'vocabulary-filter', occurrences: expect.any(Array) },
    ]);
    expect(excluded[0].occurrences).toHaveLength(4);
  });

  it('判定谓词给出的拦截原因记录到 excluded（含词义库未收录）', async () => {
    const decisionFilter = (lemma: string) => {
      if (lemma === 'the') return { keep: false as const, reason: 'band:1k' };
      if (lemma === 'zzzq') return { keep: false as const, reason: 'not-in-word-family' };
      return { keep: true as const };
    };
    const inventoryWithoutZzzq = {
      lookup: (lemma: string) => (lemma === 'lost' ? [] : [SENSE_A, SENSE_B, SENSE_C]),
    };
    const disambiguator = stubDisambiguator({ '0:0': SENSE_A.id });
    const { assignments, excluded } = await resolveSenseAssignments(
      [term('run', 2), term('the', 3), term('zzzq', 1), term('lost', 2)],
      {
        senseInventory: inventoryWithoutZzzq,
        senseDisambiguator: disambiguator,
        vocabularyFilter: decisionFilter,
        logger: silentLogger,
      },
    );
    expect(assignments.map((assignment) => assignment.lemma)).toEqual(['run']);
    expect(excluded).toEqual([
      { lemma: 'the', reason: 'band:1k', occurrences: expect.any(Array) },
      { lemma: 'zzzq', reason: 'not-in-word-family', occurrences: expect.any(Array) },
      { lemma: 'lost', reason: 'out-of-inventory', occurrences: expect.any(Array) },
    ]);
    expect(excluded[0].occurrences).toHaveLength(3);
    expect(excluded[2].occurrences).toHaveLength(2);
  });

  it('词义库未收录的词也保留在 excluded 中', async () => {
    const emptyInventory = { lookup: () => [] };
    const { assignments, excluded } = await resolveSenseAssignments(
      [term('run', 2)],
      { senseInventory: emptyInventory, logger: silentLogger },
    );
    expect(assignments).toEqual([]);
    expect(excluded).toEqual([
      { lemma: 'run', reason: 'out-of-inventory', occurrences: expect.any(Array) },
    ]);
  });
});

describe('vocabulary-index', () => {
  const index = loadVocabularyIndexFromFile('data/bnc-coca-l6-v2.0.0.json');

  it('按 headword 与 members 查询频段和频次', () => {
    expect(index.lookup('able')).toEqual({ band: '1k', totalFrequency: 47760 });
    expect(index.lookup('inability')).toEqual({ band: '1k', totalFrequency: 47760 });
    expect(index.lookup('zzzq-unknown')).toBeNull();
  });

  it('默认滤掉 1k 基础频段，传空数组可关闭', () => {
    const defaultFilter = createVocabularyFilter(index);
    expect(defaultFilter('able')).toBe(false);
    expect(defaultFilter('abandon')).toBe(true);
    const noBandFilter = createVocabularyFilter(index, { excludeBands: [] });
    expect(noBandFilter('able')).toBe(true);
  });

  it('excludeBands 过滤基础频段', () => {
    const filter = createVocabularyFilter(index, { excludeBands: ['1k'] });
    expect(filter('able')).toBe(false);
    expect(filter('a')).toBe(false);
  });

  it('频次上限过滤超高频词，找不到词族的词不收录', () => {
    const filter = createVocabularyFilter(index, { excludeBands: [], excludeFrequencyAtOrAbove: 50_000 });
    expect(filter('a')).toBe(false);
    expect(filter('able')).toBe(true);
    expect(filter('zzzq-unknown')).toBe(false);
  });

  it('isKnown 覆盖词表判断', () => {
    const filter = createVocabularyFilter(index, { excludeBands: [], isKnown: (lemma) => lemma === 'able' });
    expect(filter('able')).toBe(false);
    expect(filter('accept')).toBe(true);
  });

  it('判定谓词给出具体拦截原因，与布尔谓词结论一致', () => {
    const decide = createVocabularyDecisionFilter(index, {
      excludeBands: ['1k'],
      excludeFrequencyAtOrAbove: 50_000,
      isKnown: (lemma) => lemma === 'accept',
    });
    expect(decide('accept')).toEqual({ keep: false, reason: 'known' });
    expect(decide('able')).toEqual({ keep: false, reason: 'band:1k' });
    expect(decide('a')).toEqual({ keep: false, reason: 'band:1k' });
    expect(decide('develop')).toEqual({ keep: false, reason: 'frequency>=50000' });
    expect(decide('zzzq-unknown')).toEqual({ keep: false, reason: 'not-in-word-family' });
    expect(decide('abandon')).toEqual({ keep: true });
    // 布尔谓词与判定谓词同结论
    const boolFilter = createVocabularyFilter(index, {
      excludeBands: ['1k'],
      excludeFrequencyAtOrAbove: 50_000,
      isKnown: (lemma) => lemma === 'accept',
    });
    for (const lemma of ['accept', 'able', 'a', 'develop', 'zzzq-unknown', 'abandon']) {
      expect(boolFilter(lemma)).toBe(decide(lemma).keep);
    }
  });
});
