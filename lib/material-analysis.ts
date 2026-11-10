import { estimateInitialScores, type InitialScoreEstimate, type RankSource, type VocabularyEstimate } from './vocabulary';

export type MaterialFormat = 'text' | 'markdown' | 'pdf';
export interface MaterialWordFrequency {
  lemma: string;
  partOfSpeech?: string;
  frequency: number;
  perMillion?: number;
  /** One-based rank in the source's complete vocabulary list. */
  rank: number;
}
export interface VocabularyFrequencyIndex {
  readonly source: RankSource;
  lookup(lemma: string): MaterialWordFrequency | undefined;
}
export interface MaterialWordAnalysis {
  word: string;
  lemma: string;
  materialFrequency: number;
  materialRank: number;
  vocabularyFrequency: number | null;
  vocabularyPerMillion: number | null;
  vocabularyRank: number | null;
  estimate: InitialScoreEstimate;
}
export interface MaterialAnalysis {
  schemaVersion: '1';
  status: 'analyzed' | 'rank_unavailable';
  source: { name: string; version: string; rankSource: RankSource };
  tokenCount: number;
  uniqueWordCount: number;
  words: MaterialWordAnalysis[];
  unknownWords: string[];
}

export interface MaterialFrequencyReport {
  schemaVersion: '1';
  sourceFile: string;
  extraction: MaterialFormat;
  tokenCount: number;
  uniqueWordCount: number;
  words: Array<{ lemma: string; frequency: number; rank: number; surfaceForms: Array<{ word: string; frequency: number }> }>;
}

/** Complete P7.2 entry point: extract source material, count surface forms, and rank them. */
export async function analyzeMaterial(input: { data: string | Uint8Array; filename: string; mimeType?: string }, options: MaterialExtractionOptions = {}): Promise<MaterialFrequencyReport> {
  const extracted = await extractMaterialText(input, options);
  const tokens = extracted.text.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? [];
  const lemmatizer = await loadEnglishLemmatizer();
  const counts = new Map<string, Map<string, number>>();
  for (const token of tokens) {
    const lemma = lemmatizer(token);
    let forms = counts.get(lemma);
    if (!forms) { forms = new Map(); counts.set(lemma, forms); }
    forms.set(token, (forms.get(token) ?? 0) + 1);
  }
  const words = [...counts].map(([lemma, forms]) => ({ lemma, frequency: [...forms.values()].reduce((a, b) => a + b, 0), surfaceForms: [...forms].map(([word, frequency]) => ({ word, frequency })).sort((a, b) => b.frequency - a.frequency || a.word.localeCompare(b.word)) }))
    .sort((a, b) => b.frequency - a.frequency || a.lemma.localeCompare(b.lemma))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  return { schemaVersion: '1', sourceFile: input.filename, extraction: extracted.format, tokenCount: tokens.length, uniqueWordCount: words.length, words };
}

async function loadEnglishLemmatizer(): Promise<(word: string) => string> {
  const lemmatize = await import('wink-lemmatizer');
  return (word: string) => {
    // Without contextual POS tagging, prefer a recognized verb inflection, then noun,
    // then adjective. Keep the surface form whenever the library finds no change.
    const candidates = [lemmatize.verb(word), lemmatize.noun(word), lemmatize.adjective(word)];
    return candidates.find(candidate => candidate !== word) ?? word;
  };
}

/** A compact immutable index suitable for loading a checked-in/local frequency table. */
export function createVocabularyFrequencyIndex(rows: MaterialWordFrequency[], source: RankSource): VocabularyFrequencyIndex {
  if (!source.id || !source.basis) throw new RangeError('frequency source id and basis are required');
  const entries = new Map<string, MaterialWordFrequency>();
  for (const row of rows) {
    const lemma = normalizeLemma(row.lemma);
    if (!lemma || !Number.isFinite(row.frequency) || row.frequency < 0 || !Number.isInteger(row.rank) || row.rank < 1) throw new RangeError(`invalid frequency row: ${row.lemma}`);
    if (entries.has(lemma)) throw new RangeError(`duplicate lemma: ${lemma}`);
    entries.set(lemma, { ...row, lemma });
  }
  return { source: { ...source }, lookup: lemma => entries.get(normalizeLemma(lemma)) };
}

/** Analyze already extracted text. Lemmatization is deliberately an injected, versioned boundary. */
export function analyzeMaterialText(text: string, options: {
  index: VocabularyFrequencyIndex; vocabulary?: VocabularyEstimate; name?: string; version?: string;
  lemmatize?: (word: string) => string;
}): MaterialAnalysis {
  if (typeof text !== 'string' || !text.trim()) throw new RangeError('material text must not be empty');
  const lemmatize = options.lemmatize ?? (word => word);
  const counts = new Map<string, number>();
  const surface = new Map<string, string>();
  const tokens = text.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? [];
  for (const token of tokens) {
    const lemma = normalizeLemma(lemmatize(token));
    if (!lemma) continue;
    counts.set(lemma, (counts.get(lemma) ?? 0) + 1);
    if (!surface.has(lemma)) surface.set(lemma, token);
  }
  const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const unknownWords: string[] = [];
  const words = ordered.map(([lemma, frequency], index): MaterialWordAnalysis => {
    const entry = options.index.lookup(lemma);
    if (!entry) unknownWords.push(lemma);
    return {
      word: surface.get(lemma) ?? lemma, lemma, materialFrequency: frequency, materialRank: index + 1,
      vocabularyFrequency: entry?.frequency ?? null, vocabularyPerMillion: entry?.perMillion ?? null,
      vocabularyRank: entry?.rank ?? null,
      estimate: options.vocabulary && entry
        ? estimateInitialScores({ vocabulary: options.vocabulary, wordRank: { value: entry.rank, source: options.index.source } })
        : { R: 0, P: 0, band: 'unknown', comparable: false, reason: entry ? 'rank_unavailable' : 'rank_unavailable' },
    };
  });
  return {
    schemaVersion: '1', status: unknownWords.length ? 'rank_unavailable' : 'analyzed',
    source: { name: options.name ?? 'local-frequency-index', version: options.version ?? 'unversioned', rankSource: { ...options.index.source } },
    tokenCount: tokens.length, uniqueWordCount: counts.size, words, unknownWords,
  };
}

export interface MaterialExtractionOptions {
  /** Override OCR in tests or supply language-specific OCR. Return null to skip OCR. */
  ocrPage?: (page: unknown, scale: number) => Promise<string | null>;
  ocrLanguage?: string;
  minTextCharacters?: number;
  pdfPassword?: string;
}

export async function extractMaterialText(input: { data: string | Uint8Array; filename: string; mimeType?: string }, options: MaterialExtractionOptions = {}): Promise<{ format: MaterialFormat; text: string }> {
  const ext = input.filename.toLocaleLowerCase().split('.').pop();
  if (ext === 'pdf' || input.mimeType === 'application/pdf') {
    // Keep the ESM import native: Jest's current CommonJS transform rewrites import().
    const loadEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const pdfjs = await loadEsm('pdfjs-dist/legacy/build/pdf.mjs');
    const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, ...(options.pdfPassword ? { password: options.pdfPassword } : {}) }).promise;
    const pages: string[] = [];
    const minimum = options.minTextCharacters ?? 20;
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      let pageText = (content.items as Array<{ str?: string }>).map((item: { str?: string }) => item.str ?? '').join(' ').trim();
      if (pageText.replace(/\s/g, '').length < minimum && !options.ocrPage && options.ocrLanguage !== 'none') {
        const ocr = await defaultOcr(page, options.ocrLanguage ?? 'eng');
        if (ocr?.trim()) pageText = ocr.trim();
      }
      if (pageText) pages.push(pageText);
    }
    const text = pages.join('\n').trim();
    if (!text) throw new Error('pdf_text_unavailable');
    assertReadableText(text);
    return { format: 'pdf', text };
  }
  if (ext !== 'txt' && ext !== 'md' && ext !== 'markdown' && input.mimeType && !input.mimeType.startsWith('text/')) throw new Error('unsupported_material_format');
  let text: string;
  try { text = typeof input.data === 'string' ? input.data : new TextDecoder('utf-8', { fatal: true }).decode(input.data); }
  catch { throw new Error('text_encoding_invalid: expected UTF-8'); }
  assertReadableText(text);
  return { format: ext === 'md' || ext === 'markdown' ? 'markdown' : 'text', text };
}

async function defaultOcr(page: any, language: string): Promise<string | null> {
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const { createWorker } = await import('tesseract.js');
    const path = await import('node:path');
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const localData = path.resolve(process.cwd(), '.data/tessdata');
    const worker = await createWorker(language, 1, { langPath: localData, gzip: true, cacheMethod: 'none' });
    try { const result = await worker.recognize(canvas.toBuffer('image/png')); return result.data.text; }
    finally { await worker.terminate(); }
  } catch (error) {
    if (error instanceof Error && /traineddata|language/i.test(error.message)) throw new Error(`pdf_ocr_unavailable: ${error.message}`);
    throw error;
  }
}

function assertReadableText(text: string): void {
  if (text.includes('\u0000')) throw new Error('text_decode_error: null characters found');
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  const suspicious = (text.match(/[ÃÂâ€™]/g) ?? []).length;
  const visible = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (replacement > 0 || suspicious >= 3 && suspicious / Math.max(1, visible) > 0.02) throw new Error('text_decode_error: text appears corrupted or garbled');
}

function normalizeLemma(word: string): string { return word.normalize('NFKC').toLocaleLowerCase('en').trim(); }
