import { describe, expect, test } from '@jest/globals';
import { analyzeMaterial, analyzeMaterialText, createVocabularyFrequencyIndex, extractMaterialText } from '../lib/material-analysis';

describe('P7.2 material analysis', () => {
  test.each([
    ['notes.txt', 'A café is open.'],
    ['notes.md', '# Café\n\nA café is open.'],
  ])('extracts UTF-8 text from %s without changing its content', async (filename, text) => {
    await expect(extractMaterialText({ filename, data: text })).resolves.toMatchObject({ text });
  });

  test('reports invalid UTF-8 and garbled text instead of silently accepting it', async () => {
    await expect(extractMaterialText({ filename: 'bad.txt', data: new Uint8Array([0xff, 0xfe]) })).rejects.toThrow('text_encoding_invalid');
    await expect(extractMaterialText({ filename: 'bad.md', data: '�� broken text' })).rejects.toThrow('text_decode_error');
  });

  test('aggregates material counts by word family and reports its band', () => {
    const index = createVocabularyFrequencyIndex([
      { word: 'run', band: '2k', partOfSpeech: 'verb' },
    ], { id: 'fixture-v1', basis: 'word-family-frequency-band' });
    const result = analyzeMaterialText('Run runs running.', { index, name: 'fixture', version: '1' });
    expect(result.words.map(({ headword, materialFrequency, materialRank, vocabularyBand }) => ({ headword, materialFrequency, materialRank, vocabularyBand }))).toEqual([
      { headword: 'run', materialFrequency: 3, materialRank: 1, vocabularyBand: '1k' },
    ]);
    expect(result.status).toBe('analyzed');
  });

  test('regression: uses the supplied custom frequency index for material word bands', () => {
    const index = createVocabularyFrequencyIndex([
      { word: 'quokka', band: '25k' },
    ], { id: 'custom-frequency-v1', basis: 'custom-word-band' });
    const result = analyzeMaterialText('quokka quokka', { index });
    expect(result.words).toHaveLength(1);
    expect(result.words[0]).toMatchObject({ word: 'quokka', headword: 'quokka', materialFrequency: 2, vocabularyBand: '25k' });
    expect(result.status).toBe('analyzed');
  });

  test('keeps ambiguous homographs out of family totals', () => {
    const index = createVocabularyFrequencyIndex([{ word: 'bank', band: '3k' }], { id: 'fixture-v1', basis: 'word-family-frequency-band' });
    const result = analyzeMaterialText('bank', { index });
    expect(result.words[0]).toMatchObject({ headword: 'bank', vocabularyBand: '1k' });
  });

  test('estimates initial scores through P3 band-based target word API', () => {
    const { VOCABULARY_LIST_SOURCE } = require('../lib/vocabulary-reference') as typeof import('../lib/vocabulary-reference');
    const { estimateTargetWordInitialScores } = require('../lib/vocabulary') as typeof import('../lib/vocabulary');
    const result = analyzeMaterialText('the', {
      index: createVocabularyFrequencyIndex([{ word: 'the', band: '1k', partOfSpeech: 'determiner' }], VOCABULARY_LIST_SOURCE),
      vocabulary: { size: 1000, listSource: VOCABULARY_LIST_SOURCE },
    });
    expect(result.words[0].estimate).toMatchObject(estimateTargetWordInitialScores({
      vocabulary: { size: 1000, listSource: VOCABULARY_LIST_SOURCE }, target: { word: 'the', partOfSpeech: 'determiner' },
    }));
    expect(result.words[0].estimate).toMatchObject({ lookup: 'matched', comparable: true });
  });

  test('complete extraction still reports surface forms and material ranks', async () => {
    const report = await analyzeMaterial({ filename: 'forms.txt', data: 'Cats chased a cat and are chasing cats.' });
    expect(report.words.find(row => row.lemma === 'cat')).toMatchObject({
      frequency: 3,
      surfaceForms: [{ word: 'cats', frequency: 2 }, { word: 'cat', frequency: 1 }],
    });
    expect(report.words.find(row => row.lemma === 'chase')).toMatchObject({
      frequency: 2,
      surfaceForms: expect.arrayContaining([{ word: 'chased', frequency: 1 }, { word: 'chasing', frequency: 1 }]),
    });
  });
});
