import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { CONFIG } from './config';
import { persistBookAnalysis } from './book-store';

// PDF 任务处理器：逐页提取文字层，扫描页回退 OCR。
// 长任务（1000 页扫描件可达数十分钟），在后台串行队列里跑，进度写 book_jobs 表。

type TesseractWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

// 串行队列：OCR worker 内存开销大，多本 PDF 排队处理
const globalForQueue = globalThis as unknown as { __pdfQueue?: Promise<void> };
const queue = (globalForQueue.__pdfQueue ??= Promise.resolve());

export function enqueuePdfJob(db: Database.Database, jobId: number, filePath: string, title: string) {
  globalForQueue.__pdfQueue = queue.then(() => processPdfJob(db, jobId, filePath, title));
}

async function processPdfJob(
  db: Database.Database,
  jobId: number,
  filePath: string,
  title: string
): Promise<void> {
  const update = db.prepare(
    `UPDATE book_jobs SET total_pages = ?, processed_pages = ?, ocr_pages = ?,
     text_chars = ?, status = ?, source_id = ?, error = ?, updated_at = ? WHERE id = ?`
  );
  const state = {
    total: 0,
    done: 0,
    ocr: 0,
    chars: 0,
    status: 'processing',
    sourceId: null as number | null,
    error: null as string | null,
  };
  const flush = () =>
    update.run(
      state.total,
      state.done,
      state.ocr,
      state.chars,
      state.status,
      state.sourceId,
      state.error,
      Date.now(),
      jobId
    );

  let worker: TesseractWorker | null = null;
  try {
    const buffer = readFileSync(filePath);

    // pdfjs 渲染依赖浏览器全局对象，用 @napi-rs/canvas 补齐
    const napiCanvas = await import('@napi-rs/canvas');
    const g = globalThis as Record<string, unknown>;
    g.DOMMatrix ??= napiCanvas.DOMMatrix;
    g.ImageData ??= napiCanvas.ImageData;
    g.Path2D ??= napiCanvas.Path2D;

    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument: (src: { data: Uint8Array }) => {
        promise: Promise<{
          numPages: number;
          getPage: (n: number) => Promise<{
            getTextContent: () => Promise<{ items: { str: string }[] }>;
            getViewport: (o: { scale: number }) => { width: number; height: number };
            render: (o: {
              canvasContext: unknown;
              viewport: { width: number; height: number };
            }) => { promise: Promise<void> };
            cleanup: () => void;
          }>;
          destroy?: () => Promise<void>;
        }>;
      };
    };

    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    state.total = Math.min(doc.numPages, CONFIG.PDF_MAX_PAGES);
    flush();

    const texts: string[] = [];
    for (let p = 1; p <= state.total; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let pageText = content.items.map((i) => i.str).join(' ');

      // 文字层近乎为空 → 判定为扫描页，渲染成图后 OCR
      if (pageText.replace(/\s/g, '').length < CONFIG.PDF_TEXT_MIN_CHARS) {
        const { createWorker } = await import('tesseract.js');
        worker ??= await createWorker('eng');
        const viewport = page.getViewport({ scale: CONFIG.PDF_OCR_SCALE });
        const canvas = napiCanvas.createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height)
        );
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const { data } = await worker.recognize(canvas.toBuffer('image/png'));
        pageText = data.text;
        state.ocr++;
      }

      texts.push(pageText);
      state.done = p;
      state.chars += pageText.length;
      if (p % 5 === 0 || p === state.total) flush();
      page.cleanup();
    }
    // 新版 pdfjs 文档对象未必有 destroy（改为 loadingTask.destroy），防御性调用
    if (typeof doc.destroy === 'function') await doc.destroy();

    const fullText = texts.join('\n');
    const result = persistBookAnalysis(db, title, fullText);
    state.sourceId = result.sourceId;
    state.status = 'done';
    flush();
  } catch (e) {
    state.status = 'error';
    state.error = (e as Error).message;
    flush();
  } finally {
    if (worker) await worker.terminate();
  }
}
