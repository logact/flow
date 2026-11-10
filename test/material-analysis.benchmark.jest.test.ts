import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { extractMaterialText } from '../lib/material-analysis';

/**
 * External reference: NLTK's official book uses its Gutenberg corpus entry
 * `melville-moby_dick.txt` and reports 260,819 tokens, 19,317 distinct tokens,
 * and 906 occurrences of the lowercase token `whale`.
 * https://www.nltk.org/book/ch01.html
 *
 * Set P72_MOBY_DICK_MATERIAL to that same corpus text, or a PDF made from it.
 * We assert the reference's explicitly published lowercase `whale` count;
 * token totals depend on tokenizer conventions, so the NLTK totals are retained
 * here as source metadata rather than compared to this app's different tokenizer.
 */
const materialPath = process.env.P72_MOBY_DICK_MATERIAL;

describe('P7.2 Moby-Dick extraction benchmark (NLTK reference)', () => {
  const runBenchmark = materialPath ? test : test.skip;

  runBenchmark('extracts the independently published count for "whale"', async () => {
    const bytes = new Uint8Array(fs.readFileSync(materialPath!));
    const extracted = await extractMaterialText(
      { filename: materialPath!, data: bytes },
      { minTextCharacters: 0, ocrLanguage: 'none' },
    );
    const matches = extracted.text.match(/\bwhale\b/g) ?? [];
    expect(matches.length).toBe(906);
  }, 60_000);
});
