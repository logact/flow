// 生成两种测试 PDF：
//  /tmp/flow-test-text.pdf —— 有文字层的普通 PDF
//  /tmp/flow-test-scan.pdf —— 纯图片的"扫描件"PDF（文字渲染成图片嵌入，必须 OCR 才能读出）
import PDFDocument from 'pdfkit';
import { createCanvas } from '@napi-rs/canvas';
import { createWriteStream } from 'node:fs';

const SAMPLE = `Deep work is the ability to focus without distraction on a demanding task. Most people believe they focus well, but constant distraction has weakened their attention. Every notification pulls attention away from the task, and each switch makes the brain slower. To rebuild attention, schedule a daily deep work session and protect it. During a session, the phone stays outside the room. One task, one hour, zero distraction. At first the brain resists. Boredom appears within minutes, and the urge to check the phone feels physical. That discomfort is the training. A short session every morning builds the focus muscle faster than a long session once a week. Over a month, the brain adapts: distraction loses its grip, and deep focus becomes the default. The quality of work rises, tasks finish faster, and attention turns into a genuine advantage.`;

function makeTextPdf(path) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = createWriteStream(path);
    doc.pipe(stream);
    doc.fontSize(12);
    for (let i = 0; i < 12; i++) {
      doc.text(`Chapter ${i + 1}\n\n${SAMPLE}\n\n${SAMPLE}\n\n`);
    }
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function renderPagePng(lines) {
  const canvas = createCanvas(612, 792);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 612, 792);
  ctx.fillStyle = '#111111';
  ctx.font = '18px sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, 50, 60 + i * 28));
  return canvas.toBuffer('image/png');
}

function makeScanPdf(path) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', autoFirstPage: false });
    const stream = createWriteStream(path);
    doc.pipe(stream);
    const lines = wrapText(`${SAMPLE} ${SAMPLE}`, 70);
    const perPage = 24;
    for (let p = 0; p < Math.ceil(lines.length / perPage); p++) {
      doc.addPage();
      const png = renderPagePng(lines.slice(p * perPage, (p + 1) * perPage));
      doc.image(png, 0, 0, { width: 612, height: 792 });
    }
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

await makeTextPdf('/tmp/flow-test-text.pdf');
console.log('text pdf done');
await makeScanPdf('/tmp/flow-test-scan.pdf');
console.log('scan pdf done');
