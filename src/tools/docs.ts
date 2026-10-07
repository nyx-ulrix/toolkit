import type { Tool } from '../types';
import { htmlToMd, htmlToText, mdToHtml, pdfToMd, textToHtml, wrapHtml } from '../lib/docs';
import { rename } from '../ui';

const ext = (f: File) => f.name.split('.').pop()!.toLowerCase();

export const docConvert: Tool = {
  id: 'document-converter', group: 'Convert', title: 'Document converter',
  desc: 'Word (.docx) and PDF to Markdown, plus Markdown, HTML and plain text between each other.',
  accept: '.docx,.pdf,.html,.htm,.md,.markdown,.txt',
  note: 'Old .doc files are not supported; save them as .docx first. Scanned PDFs have no text, use PDF OCR for those.',
  opts: [
    { key: 'format', label: 'Convert to', type: 'select', value: 'md', choices: [['md', 'Markdown (.md)'], ['html', 'HTML'], ['txt', 'Plain text']] },
    { key: 'images', label: 'Keep images (Word files, saved in a zip with the Markdown)', type: 'checkbox', value: true },
  ],
  async run(file, o, ctx) {
    const e = ext(file);
    const images: { name: string; data: ArrayBuffer }[] = [];
    let md: string | undefined;
    let html: string | undefined;

    ctx.progress(0.1, 'Reading…');
    if (e === 'docx') {
      const mammoth = await import('mammoth');
      const res = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, {
        convertImage: mammoth.images.imgElement(async (img) => {
          if (!o.images) return { src: '' };
          const name = `image${images.length + 1}.${img.contentType.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*/, '') || 'png'}`;
          const buf = await img.readAsArrayBuffer();
          images.push({ name, data: buf });
          return { src: `images/${name}` };
        }),
      });
      html = res.value;
    } else if (e === 'pdf') {
      md = await pdfToMd(await file.arrayBuffer(), (f) => ctx.progress(0.1 + f * 0.8, 'Reading pages…'));
    } else if (e === 'md' || e === 'markdown') {
      md = await file.text();
    } else if (e === 'txt') {
      md = await file.text();
      if (o.format === 'html') html = textToHtml(md);
    } else {
      html = await file.text();
    }

    const base = file.name;
    let text: string, mime: string, out: string;
    if (o.format === 'md') (text = md ?? htmlToMd(html!)), (out = 'md'), (mime = 'text/markdown');
    else if (o.format === 'html') (text = wrapHtml(html ?? mdToHtml(md!), base), (out = 'html'), (mime = 'text/html'));
    else (text = htmlToText(html ?? mdToHtml(md!)), (out = 'txt'), (mime = 'text/plain'));

    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    if (!images.length) return [{ name: rename(base, out), blob }];

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file(rename(base, out), blob);
    for (const i of images) zip.file(`images/${i.name}`, i.data);
    return [{ name: rename(base, 'zip'), blob: await zip.generateAsync({ type: 'blob' }), note: `${images.length} image(s) in images/` }];
  },
};


