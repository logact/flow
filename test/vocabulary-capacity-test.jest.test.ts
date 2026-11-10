import { describe, expect, test } from '@jest/globals';
import {
  createVocabularyCapacityTest,
  checkVocabularyCapacityTest,
  getVocabularyCapacityLearnerView,
  recordVocabularyCapacityTestResult,
  estimateVocabularyCapacityByBand,
  type VocabularyCapacityTestForm,
  type VocabularyCapacityTestSubmission,
  type VocabularyCapacityByBandEstimateEvent,
  type FrequencyBand,
} from '../lib/vocabulary';
import type { FamilyList } from '../lib/vocabulary-reference';

function makeList(
  families: Array<{ id: string; headword: string; band: FrequencyBand }>,
  source = 'test-source',
  version = '1.0.0',
): FamilyList {
  return {
    source,
    version,
    families: families.map(f => ({ ...f, members: [f.headword] })),
  };
}

const BASIS = 'word-family-frequency-band';

function makeSubmission(
  form: VocabularyCapacityTestForm,
  answers: Array<{ itemId: string; correct: boolean }>,
  overrides: Partial<VocabularyCapacityTestSubmission> = {},
): VocabularyCapacityTestSubmission {
  return {
    testId: form.testId,
    listSource: { ...form.listSource },
    sourceVersion: form.sourceVersion,
    answers,
    ...overrides,
  };
}

describe('createVocabularyCapacityTest', () => {
  const list = makeList(
    Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, headword: `word${i}`, band: '5k' as const })),
  );

  test('is deterministic for a supplied seed', () => {
    const spec = { bands: [{ band: '5k' as const, count: 3 }], seed: 42 };
    const a = createVocabularyCapacityTest(spec, list);
    const b = createVocabularyCapacityTest(spec, list);
    expect(a.form).toEqual(b.form);
    expect(a.learnerView).toEqual(b.learnerView);
    expect(a.form.testId).toBe(b.form.testId);
  });

  test('returns a different sample for different seeds', () => {
    const a = createVocabularyCapacityTest({ bands: [{ band: '5k', count: 3 }] }, list);
    const b = createVocabularyCapacityTest({ bands: [{ band: '5k', count: 3 }] }, list);
    expect(a.form.testId).not.toBe(b.form.testId);
  });

  test('samples uniformly within a band', () => {
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 10000; seed++) {
      const { form } = createVocabularyCapacityTest({ bands: [{ band: '5k', count: 3 }], seed }, list);
      for (const key of form.answerKey) {
        counts.set(key.familyId, (counts.get(key.familyId) ?? 0) + 1);
      }
    }
    const values = [...counts.values()];
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(values).toHaveLength(10);
    expect(min).toBeGreaterThanOrEqual(2500);
    expect(max).toBeLessThanOrEqual(3500);
  });

  test('keeps answer keys separate from the learner-facing view', () => {
    const { form, learnerView } = createVocabularyCapacityTest(
      { bands: [{ band: '5k', count: 3 }], seed: 7 },
      list,
    );
    expect(learnerView.items).toHaveLength(3);
    expect('answerKey' in learnerView).toBe(false);
    expect(form.answerKey).toHaveLength(3);
    for (let i = 0; i < learnerView.items.length; i++) {
      expect(learnerView.items[i].itemId).toBe(form.answerKey[i].itemId);
      expect(learnerView.items[i].prompt).toBe(form.answerKey[i].prompt);
      expect(form.answerKey[i]).toMatchObject({ familyId: expect.any(String), band: '5k' });
    }
    expect(getVocabularyCapacityLearnerView(form)).toEqual(learnerView);
  });

  test('rejects invalid band specs', () => {
    expect(() => createVocabularyCapacityTest({ bands: [] }, list)).toThrow(RangeError);
    expect(() => createVocabularyCapacityTest({ bands: [{ band: '5k', count: 0 }] }, list)).toThrow(RangeError);
    expect(() => createVocabularyCapacityTest({ bands: [{ band: '5k', count: 11 }] }, list)).toThrow(RangeError);
    expect(() => createVocabularyCapacityTest({ bands: [{ band: '6k', count: 1 }] }, list)).toThrow(RangeError);
    expect(() =>
      createVocabularyCapacityTest({ bands: [{ band: '5k', count: 1 }], seed: 'x' as unknown as number }, list),
    ).toThrow(RangeError);
  });

  test('does not mutate the input spec or list', () => {
    const spec = { bands: [{ band: '5k' as const, count: 3 }], seed: 1 };
    const specCopy = structuredClone(spec);
    const listCopy = structuredClone(list);
    createVocabularyCapacityTest(spec, list);
    expect(spec).toEqual(specCopy);
    expect(list).toEqual(listCopy);
  });

  test('uses the default 100-item spec when bands are omitted', () => {
    const { form, learnerView } = createVocabularyCapacityTest({ seed: 1 });
    expect(learnerView.items).toHaveLength(100);
    expect(form.populations).toHaveLength(25);
    expect(new Set(form.populations.map(p => p.band)).size).toBe(25);
  });
});

describe('checkVocabularyCapacityTest', () => {
  const list = makeList([
    ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, headword: `alpha${i}`, band: '5k' as const })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, headword: `beta${i}`, band: '6k' as const })),
  ]);
  const spec = { bands: [{ band: '5k' as const, count: 2 }, { band: '6k' as const, count: 2 }], seed: 99 };
  const { form } = createVocabularyCapacityTest(spec, list);
  const baseAnswers = form.learnerItems.map(i => ({ itemId: i.itemId, correct: true }));

  test('accepts a valid submission and produces a P3-compatible estimate input', () => {
    const submission = makeSubmission(form, baseAnswers);
    const result = checkVocabularyCapacityTest(form, submission, list);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.input.items).toHaveLength(4);
    expect(result.input.populations).toEqual([
      { band: '5k', familyCount: 10 },
      { band: '6k', familyCount: 10 },
    ]);
    const estimate = estimateVocabularyCapacityByBand(result.input);
    expect(estimate.size).toBe(20);
  });

  test('all-correct and all-incorrect bound the estimate', () => {
    const allCorrect = makeSubmission(form, baseAnswers);
    const allWrong = makeSubmission(form, baseAnswers.map(a => ({ ...a, correct: false })));
    const vCorrect = checkVocabularyCapacityTest(form, allCorrect, list);
    const vWrong = checkVocabularyCapacityTest(form, allWrong, list);
    expect(vCorrect.valid && estimateVocabularyCapacityByBand(vCorrect.input).size).toBe(20);
    expect(vWrong.valid && estimateVocabularyCapacityByBand(vWrong.input).size).toBe(0);
  });

  test('rejects test/list identity mismatches', () => {
    expect(checkVocabularyCapacityTest(form, makeSubmission(form, baseAnswers, { testId: 'other' }), list).valid).toBe(false);
    expect(checkVocabularyCapacityTest(form, makeSubmission(form, baseAnswers, { sourceVersion: '9.9.9' }), list).valid).toBe(false);
    expect(checkVocabularyCapacityTest(form, makeSubmission(form, baseAnswers, { listSource: { id: 'other', basis: BASIS } }), list).valid).toBe(false);
  });

  test('rejects missing, extra, and duplicate answers', () => {
    const missing = baseAnswers.slice(1);
    expect(checkVocabularyCapacityTest(form, makeSubmission(form, missing), list).valid).toBe(false);

    const extra = [...baseAnswers, { itemId: 'item:unknown', correct: true }];
    expect(checkVocabularyCapacityTest(form, makeSubmission(form, extra), list).valid).toBe(false);

    const duplicate = [...baseAnswers, { itemId: baseAnswers[0].itemId, correct: false }];
    expect(checkVocabularyCapacityTest(form, makeSubmission(form, duplicate), list).valid).toBe(false);
  });

  test('rejects non-boolean answer values', () => {
    const bad = baseAnswers.map((a, i) => (i === 0 ? { ...a, correct: 'yes' as unknown as boolean } : a));
    const result = checkVocabularyCapacityTest(form, makeSubmission(form, bad), list);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some(e => e.itemId === bad[0].itemId)).toBe(true);
  });

  test('rejects a family outside the pinned list or in the wrong band', () => {
    const tamperedForm: VocabularyCapacityTestForm = {
      ...form,
      answerKey: form.answerKey.map((k, i) =>
        i === 0 ? { ...k, familyId: 'missing-family' } : k,
      ),
    };
    const submission = makeSubmission(tamperedForm, baseAnswers);
    expect(checkVocabularyCapacityTest(tamperedForm, submission, list).valid).toBe(false);

    const wrongBand: VocabularyCapacityTestForm = {
      ...form,
      answerKey: form.answerKey.map((k, i) =>
        i === 0 ? { ...k, band: '6k' as const } : k,
      ),
    };
    expect(checkVocabularyCapacityTest(wrongBand, makeSubmission(wrongBand, baseAnswers), list).valid).toBe(false);
  });

  test('rejects duplicate families inside the form', () => {
    const dupForm: VocabularyCapacityTestForm = {
      ...form,
      answerKey: form.answerKey.map((k, i) => (i === 1 ? { ...k, familyId: form.answerKey[0].familyId } : k)),
    };
    expect(checkVocabularyCapacityTest(dupForm, makeSubmission(dupForm, baseAnswers), list).valid).toBe(false);
  });

  test('does not mutate the form or submission', () => {
    const submission = makeSubmission(form, baseAnswers);
    const formCopy = structuredClone(form);
    const subCopy = structuredClone(submission);
    checkVocabularyCapacityTest(form, submission, list);
    expect(form).toEqual(formCopy);
    expect(submission).toEqual(subCopy);
  });
});

describe('recordVocabularyCapacityTestResult', () => {
  const list = makeList(
    Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, headword: `word${i}`, band: '4k' as const })),
  );
  const { form } = createVocabularyCapacityTest({ bands: [{ band: '4k', count: 4 }], seed: 123 }, list);
  const answers = form.learnerItems.map(i => ({ itemId: i.itemId, correct: true }));

  test('emits an estimate event for a valid submission', () => {
    const events: VocabularyCapacityByBandEstimateEvent[] = [];
    const submission = makeSubmission(form, answers);
    const { checked, event } = recordVocabularyCapacityTestResult(form, submission, e => events.push(e), list);
    expect(checked.valid).toBe(true);
    expect(event).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('vocabulary.capacity_estimated');
    expect(events[0].evidence).toEqual([{ band: '4k', familyCount: 8, questions: 4, correct: 4 }]);
    expect(events[0].estimate.size).toBe(8);
  });

  test('does not estimate or emit an event for an invalid submission', () => {
    const events: VocabularyCapacityByBandEstimateEvent[] = [];
    const submission = makeSubmission(form, answers.slice(1));
    const { checked, event } = recordVocabularyCapacityTestResult(form, submission, e => events.push(e), list);
    expect(checked.valid).toBe(false);
    expect(event).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});

describe('createVocabularyCapacityTest with pinned BNC/COCA list', () => {
  test('creates a valid multi-band test from the shipped list', () => {
    const { form, learnerView } = createVocabularyCapacityTest({
      bands: [
        { band: '1k', count: 3 },
        { band: '2k', count: 3 },
      ],
      seed: 2026,
    });
    expect(learnerView.items).toHaveLength(6);
    expect(form.populations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ band: '1k' }),
        expect.objectContaining({ band: '2k' }),
      ]),
    );
    const answers = learnerView.items.map(i => ({ itemId: i.itemId, correct: true }));
    const checked = checkVocabularyCapacityTest(form, {
      testId: form.testId,
      listSource: { ...form.listSource },
      sourceVersion: form.sourceVersion,
      answers,
    });
    expect(checked.valid).toBe(true);
  });
});
