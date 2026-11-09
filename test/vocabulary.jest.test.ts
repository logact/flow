import { describe, expect, test } from '@jest/globals';
import { logger as appLogger } from '../lib/logger';
import {
  estimateVocabularyCapacity,
  estimateInitialScores,
  recordVocabularyCapacityEstimate,
  recordVocabularyEstimate,
  type InitialScoreEstimateInput,
  type RankSource,
} from '../lib/vocabulary';

const source: RankSource = { id: 'frequency-en-v1', basis: 'lemma-frequency-rank' };
const makeInput = (rank: number | null, overrides: Partial<InitialScoreEstimateInput> = {}): InitialScoreEstimateInput => ({
  vocabulary: { size: 1000, rankSource: source },
  wordRank: { value: rank, source: rank === null ? null : source },
  ...overrides,
});

describe('P3.1 vocabulary capacity estimate', () => {
  test('extrapolates known proportions across rank strata into the P3 interface', () => {
    expect(estimateVocabularyCapacity({
      rankSource: source,
      strata: [
        { rankStart: 0, rankEnd: 1000, correct: 8, questions: 10 },
        { rankStart: 1000, rankEnd: 3000, correct: 5, questions: 10 },
      ],
    })).toEqual({ size: 1800, rankSource: source });
  });

  test('returns zero for all incorrect answers and the sampled range for all correct answers', () => {
    const base = { rankSource: source, strata: [{ rankStart: 0, rankEnd: 2000, questions: 20 }] };
    expect(estimateVocabularyCapacity({ ...base, strata: [{ ...base.strata[0], correct: 0 }] }).size).toBe(0);
    expect(estimateVocabularyCapacity({ ...base, strata: [{ ...base.strata[0], correct: 20 }] }).size).toBe(2000);
  });

  test.each([
    { rankSource: source, strata: [] },
    { rankSource: source, strata: [{ rankStart: 100, rankEnd: 100, correct: 1, questions: 1 }] },
    { rankSource: source, strata: [{ rankStart: 0, rankEnd: 100, correct: 2, questions: 1 }] },
    { rankSource: { id: '', basis: '' }, strata: [{ rankStart: 0, rankEnd: 100, correct: 1, questions: 1 }] },
  ])('rejects malformed test input', input => {
    expect(() => estimateVocabularyCapacity(input)).toThrow(RangeError);
  });

  test('does not mutate its input', () => {
    const input = { rankSource: source, strata: [{ rankStart: 0, rankEnd: 1000, correct: 5, questions: 10 }] };
    const before = structuredClone(input);
    expect(estimateVocabularyCapacity(input)).toEqual({ size: 500, rankSource: source });
    expect(input).toEqual(before);
  });

  test('records test provenance and the P3-compatible estimate', () => {
    const input = {
      rankSource: source,
      strata: [{ rankStart: 0, rankEnd: 1000, correct: 7, questions: 10 }],
    };
    const events: unknown[] = [];
    const event = recordVocabularyCapacityEstimate(input, value => events.push(value));
    expect(events).toHaveLength(1);
    expect(event).toEqual({
      event: 'vocabulary.capacity_estimated',
      rankSource: source,
      strata: input.strata,
      estimate: { size: 700, rankSource: source },
    });
  });

  test('writes the capacity estimate through the persistent application logger', async () => {
    const event = recordVocabularyCapacityEstimate({
      rankSource: source,
      strata: [{ rankStart: 0, rankEnd: 100, correct: 6, questions: 10 }],
    });
    await new Promise<void>(resolve => appLogger.flush(resolve));
    expect(event.event).toBe('vocabulary.capacity_estimated');
  });
});

describe('P3 initial vocabulary score estimate', () => {
  test.each([
    [500, 'common', 60, 40],
    [501, 'known', 40, 20],
    [1000, 'known', 40, 20],
    [1001, 'less_common', 20, 5],
    [1500, 'less_common', 20, 5],
    [1501, 'unknown', 0, 0],
  ] as const)('rank %s produces the specified boundary band', (rank, band, R, P) => {
    expect(estimateInitialScores(makeInput(rank))).toEqual({ R, P, band, comparable: true });
  });

  test.each([
    [null, null, 'rank_unavailable'],
    [10, null, 'rank_source_missing'],
    [10, { id: 'other', basis: source.basis }, 'rank_source_mismatch'],
    [10, { id: source.id, basis: 'raw-frequency-count' }, 'rank_source_mismatch'],
    [0, source, 'invalid_rank'],
    [-1, source, 'invalid_rank'],
    [Number.NaN, source, 'invalid_rank'],
    [Number.POSITIVE_INFINITY, source, 'invalid_rank'],
  ] as const)('invalid or incomparable rank returns zero scores (%s)', (rank, rankSource, reason) => {
    expect(estimateInitialScores(makeInput(rank, { wordRank: { value: rank, source: rankSource } }))).toEqual({
      R: 0, P: 0, band: 'unknown', comparable: false, reason,
    });
  });

  test('rejects invalid vocabulary sizes before comparing rank', () => {
    for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const input = makeInput(10, { vocabulary: { size, rankSource: source } });
      expect(estimateInitialScores(input)).toMatchObject({ R: 0, P: 0, band: 'unknown', comparable: false, reason: 'invalid_vocabulary_size' });
    }
  });

  test('is deterministic and does not mutate its input', () => {
    const input = makeInput(800);
    const before = structuredClone(input);
    expect(estimateInitialScores(input)).toEqual(estimateInitialScores(input));
    expect(input).toEqual(before);
  });

  test('records provenance, estimate, and per-axis first tasks at the caller boundary', () => {
    const input = makeInput(1600);
    const estimate = estimateInitialScores(input);
    const events: unknown[] = [];
    const event = recordVocabularyEstimate(input, estimate, value => events.push(value));
    expect(events).toHaveLength(1);
    expect(event).toMatchObject({
      event: 'vocabulary.estimated', vocabularySize: 1000,
      vocabularyRankSource: source, wordRank: 1600, wordRankSource: source,
      comparable: true, band: 'unknown', initialScores: { R: 0, P: 0 },
      firstTasks: { R: { task: 'ENCODE' }, P: { task: 'ENCODE' } },
    });
  });

  test('records nonzero initial scores with existing task thresholds', () => {
    const input = makeInput(400);
    const event = recordVocabularyEstimate(input, estimateInitialScores(input), () => undefined);
    expect(event.firstTasks).toEqual({
      R: { task: 'FLUENCY' }, P: { task: 'RETRIEVE', stage: 'free' },
    });
  });
});
