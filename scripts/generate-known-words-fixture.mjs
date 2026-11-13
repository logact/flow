#!/usr/bin/env node
/**
 * 生成 data/test-materials/known-words.pdf——材料解析黄金标准测试的夹具。
 *
 * pdfkit 逐字符排版、不做断词，因此写入 PDF 的源文本就是提取正确性的
 * ground truth；期望词表经人工核对后硬编码在
 * test/material-extraction-golden.jest.test.ts 中（与下方常量保持一致）。
 *
 * 用法：node scripts/generate-known-words-fixture.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import PDFDocument from 'pdfkit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(root, 'data', 'test-materials', 'known-words.pdf');

export const PAGE_1 = 'The team meets every week. The teams discuss problems openly. A resilient team learns from setbacks and adjusts its plan. 42 small changes keep the project moving.';
export const PAGE_2 = 'She runs every morning and he ran yesterday. Running every day builds character. The company tools are useful, and every tool works well.';

export function buildKnownWordsPdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.text(PAGE_1);
    doc.addPage();
    doc.text(PAGE_2);
    doc.end();
  });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  buildKnownWordsPdf().then((buffer) => {
    writeFileSync(OUTPUT, buffer);
    console.error('pages: 2');
    console.error(`written: ${OUTPUT}`);
  });
}
