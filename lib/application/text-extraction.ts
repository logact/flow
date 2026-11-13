import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Material } from '../domain/model';

/** 一次文本提取的产物：用于分析的正文和写入材料的附加信息。 */
export interface ExtractedText {
  /** 提取后的纯文本，直接交给材料分析。 */
  text: string;
  /** 提取过程的附加信息，例如页数、提取器和空文本页。 */
  metadata: Record<string, unknown>;
}

/** 将 Markdown 源码转换为用于分析的纯文本，保留自然语言和例句，去掉排版语法。 */
export function markdownToPlainText(markdown: string): string {
  const lines: string[] = [];
  let inCodeBlock = false;
  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(rawLine)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    let text = rawLine;
    text = text.replace(/^\s{0,3}#{1,6}\s+/, '');
    text = text.replace(/^\s*>\s?/, '');
    text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    text = text.replace(/^\s*\|(.+)\|\s*$/, (_match, row: string) =>
      row
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell && !/^:?-{3,}:?$/.test(cell))
        .join(' '));
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) continue;
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/`([^`]*)`/g, '$1');
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/\*([^*]+)\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/\b_([^_]+)_\b/g, '$1');
    text = text.replace(/~~([^~]+)~~/g, '$1');
    text = text.trim();
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function extractPlainText(data: Uint8Array): ExtractedText {
  return {
    text: decodeUtf8(data),
    metadata: { extractor: 'plain-text', encoding: 'utf-8', byteLength: data.byteLength },
  };
}

function extractMarkdownText(data: Uint8Array): ExtractedText {
  return {
    text: markdownToPlainText(decodeUtf8(data)),
    metadata: { extractor: 'markdown', encoding: 'utf-8', byteLength: data.byteLength },
  };
}

async function extractPdfText(data: Uint8Array): Promise<ExtractedText> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfModulePath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = pathToFileURL(join(dirname(pdfModulePath), '..', '..', 'standard_fonts')).href + '/';
  // pdfjs 严格要求纯 Uint8Array，不接受 Buffer 子类。
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const loadingTask = getDocument({
    data: bytes,
    standardFontDataUrl,
    disableFontFace: true,
  });
  try {
    const pdf = await loadingTask.promise;
    const pageTexts: string[] = [];
    const pagesWithoutText: number[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) pagesWithoutText.push(pageNumber);
      pageTexts.push(text);
    }
    return {
      text: pageTexts.join('\n').trim(),
      metadata: {
        extractor: 'pdfjs-dist',
        pageCount: pdf.numPages,
        pagesWithoutText,
      },
    };
  } finally {
    await loadingTask.destroy();
  }
}

/** 按材料格式从原始文件中提取用于分析的纯文本；提取失败时抛出异常。 */
export async function extractTextFromFile(
  format: Material['format'],
  data: Uint8Array,
): Promise<ExtractedText> {
  switch (format) {
    case 'txt':
      return extractPlainText(data);
    case 'markdown':
      return extractMarkdownText(data);
    case 'pdf':
      return extractPdfText(data);
  }
}
