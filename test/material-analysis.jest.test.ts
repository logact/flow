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

  test('uses injected frequency and rank behavior, with stable material counts', () => {
    const index = createVocabularyFrequencyIndex([
      { lemma: 'café', frequency: 50, perMillion: 5, rank: 1200 },
      { lemma: 'open', frequency: 100, perMillion: 10, rank: 500 },
    ], { id: 'fixture-v1', basis: 'lemma-rank' });
    const result = analyzeMaterialText('Café, open café!', { index, name: 'fixture', version: '1' });
    expect(result.words.map(({ lemma, materialFrequency, materialRank, vocabularyRank }) => ({ lemma, materialFrequency, materialRank, vocabularyRank }))).toEqual([
      { lemma: 'café', materialFrequency: 2, materialRank: 1, vocabularyRank: 1200 },
      { lemma: 'open', materialFrequency: 1, materialRank: 2, vocabularyRank: 500 },
    ]);
    expect(result.status).toBe('analyzed');
  });

  test('aggregates inflected forms under a lemma while retaining original spellings', async () => {
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
