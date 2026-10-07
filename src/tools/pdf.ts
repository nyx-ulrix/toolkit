import type { Tool } from '../types';
import { TESSERACT_LANG_PATH } from '../config';
import { canvasToBlob, loadImage, toCanvas } from '../lib/img';
import { rename } from '../ui';

export const pdfCompress: Tool = {
  id: 'compress-pdf', group: 'Optimize', title: 'Compress PDF',
  desc: 'Make PDFs smaller, right on your computer.',
  accept: 'application/pdf,.pdf',
  note: 'Strong mode redraws every page as a compressed picture, so text is no longer selectable. Run PDF OCR afterwards if you need it back.',
  opts: [
    { key: 'mode', label: 'Mode', type: 'select', value: 'strong', choices: [['light', 'Light (keeps text, small savings)'], ['strong', 'Strong (pages become images)']] },
    { key: 'dpi', label: 'Resolution', type: 'select', value: '110', choices: [['72', '72 dpi (smallest)'], ['110', '110 dpi (screen)'], ['150', '150 dpi (good print)'], ['200', '200 dpi (high)']], show: (o) => o.mode === 'strong' },
    { key: 'quality', label: 'JPEG quality', type: 'range', value: 0.6, min: 0.2, max: 0.95, step: 0.01, show: (o) => o.mode === 'strong' },
    { key: 'gray', label: 'Black & white pages', type: 'checkbox', value: false, show: (o) => o.mode === 'strong' },
  ],
  async run(file, o, ctx) {
    const { PDFDocument } = await import('pdf-lib');
    const { openPdf, renderPage } = await import('../lib/pdfjs');
    const data = await file.arrayBuffer();
    let out: Uint8Array;
    if (o.mode === 'light') {
      ctx.progress(0.3, 'Rewriting…');
      const src = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
      out = await src.save({ useObjectStreams: true });
    } else {
      const pdf = await openPdf(data);
      const dst = await PDFDocument.create();
      for (let n = 1; n <= pdf.numPages; n++) {
        ctx.progress((n - 1) / pdf.numPages, `Page ${n} of ${pdf.numPages}…`);
        const { canvas, width, height } = await renderPage(pdf, n, o.dpi / 72);
        if (o.gray) {
          const g = canvas.getContext('2d')!;
          g.globalCompositeOperation = 'saturation';
          g.fillStyle = 'hsl(0,0%,50%)';
          g.fillRect(0, 0, canvas.width, canvas.height);
        }
        const jpg = await dst.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', o.quality)).arrayBuffer()));
        dst.addPage([width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
        canvas.width = canvas.height = 0; // free the bitmap
      }
      out = await dst.save({ useObjectStreams: true });
    }
    if (out.length >= file.size) return [{ name: file.name, blob: file, note: 'could not be made smaller, kept the original' }];
    return [{ name: rename(file.name, 'pdf', '-compressed'), blob: new Blob([out as BlobPart], { type: 'application/pdf' }) }];
  },
};

const LANGS: [string, string][] = [
  ['eng', 'English'], ['chi_sim', 'Chinese (Simplified)'], ['chi_tra', 'Chinese (Traditional)'], ['msa', 'Malay'], ['tam', 'Tamil'], ['hin', 'Hindi'],
  ['jpn', 'Japanese'], ['kor', 'Korean'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese'], ['ita', 'Italian'], ['rus', 'Russian'], ['ara', 'Arabic'],
];

export const pdfOcr: Tool = {
  id: 'pdf-ocr', group: 'Optimize', title: 'PDF OCR',
  desc: 'Make scanned PDFs and photos searchable and copyable. Outputs a text-layer PDF and a .txt file.',
  accept: 'application/pdf,.pdf,image/*',
  note: 'Language data (a few MB) downloads the first time you use a language. Large scans take a while: roughly 5-20 seconds per page.',
  opts: [
    { key: 'lang', label: 'Language', type: 'select', value: 'eng', choices: LANGS },
    { key: 'outPdf', label: 'Make searchable PDF', type: 'checkbox', value: true },
  ],
  async run(file, o, ctx) {
    const { openPdf, renderPage } = await import('../lib/pdfjs');
    const T = await import('tesseract.js');
    const createWorker = T.createWorker ?? (T as any).default.createWorker; // CJS package: named export may sit on default
    ctx.progress(0.02, 'Loading OCR engine…');
    let page = 0, pages = 1;
    const worker = await createWorker(o.lang, 1, {
      ...(TESSERACT_LANG_PATH ? { langPath: TESSERACT_LANG_PATH } : {}),
      logger: (m) => m.status === 'recognizing text' && ctx.progress(Math.min(0.98, (page + m.progress) / pages), `Reading page ${page + 1} of ${pages}…`),
    });
    try {
      const sources: (() => Promise<HTMLCanvasElement>)[] = [];
      if (file.type.startsWith('image/')) sources.push(async () => toCanvas(await loadImage(file)));
      else {
        const pdf = await openPdf(await file.arrayBuffer());
        for (let n = 1; n <= pdf.numPages; n++) sources.push(async () => (await renderPage(pdf, n, 3)).canvas);
      }
      pages = sources.length;
      const { PDFDocument } = await import('pdf-lib');
      const merged = await PDFDocument.create();
      let text = '';
      for (page = 0; page < pages; page++) {
        const canvas = await sources[page]();
        const { data } = await worker.recognize(canvas, {}, { text: true, pdf: o.outPdf });
        text += data.text.trim() + (pages > 1 ? `\n\n--- page ${page + 1} ---\n\n` : '\n');
        if (o.outPdf && data.pdf) {
          const one = await PDFDocument.load(new Uint8Array(data.pdf));
          (await merged.copyPages(one, one.getPageIndices())).forEach((p) => merged.addPage(p));
        }
        canvas.width = canvas.height = 0;
      }
      const outs = [{ name: rename(file.name, 'txt'), blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) }];
      if (o.outPdf) outs.unshift({ name: rename(file.name, 'pdf', '-ocr'), blob: new Blob([(await merged.save()) as BlobPart], { type: 'application/pdf' }) });
      return outs;
    } finally {
      await worker.terminate();
    }
  },
};
