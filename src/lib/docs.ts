import TurndownService from 'turndown';
// @ts-expect-error no types
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
td.use(gfm);

export const htmlToMd = (html: string) => td.turndown(html).trim() + '\n';
export const mdToHtml = (md: string) => marked.parse(md, { async: false }) as string;

const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'PRE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE']);

export function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style').forEach((e) => e.remove());
  doc.querySelectorAll('*').forEach((e) => {
    if (e.tagName === 'TD' || e.tagName === 'TH') e.append(' ');
    if (BLOCK.has(e.tagName)) e.append('\n');
  });
  return (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
export const textToHtml = (t: string) =>
  t.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n');

export const wrapHtml = (body: string, title: string) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n${body}\n</body></html>\n`;

/** Reads a PDF's text layer and rebuilds headings, lists and paragraphs from font size and spacing. */
export async function pdfToMd(data: ArrayBuffer, progress?: (f: number) => void): Promise<string> {
  const { openPdf } = await import('./pdfjs');
  const pdf = await openPdf(data);
  type Line = { y: number; size: number; text: string; x: number };
  const pages: Line[][] = [];
  const sizeChars = new Map<number, number>();
  for (let p = 1; p <= pdf.numPages; p++) {
    progress?.(p / pdf.numPages);
    const content = await (await pdf.getPage(p)).getTextContent();
    const lines: Line[] = [];
    for (const it of content.items as any[]) {
      if (!('str' in it) || !it.str.trim()) continue;
      const size = Math.round(Math.hypot(it.transform[0], it.transform[1]) * 2) / 2;
      const y = it.transform[5], x = it.transform[4];
      const last = lines.find((l) => Math.abs(l.y - y) < size * 0.4);
      if (last) last.text += (x - last.x > size * 0.15 && !last.text.endsWith(' ') ? ' ' : '') + it.str, (last.x = x + (it.width ?? 0));
      else lines.push({ y, size, text: it.str, x: x + (it.width ?? 0) });
      sizeChars.set(size, (sizeChars.get(size) ?? 0) + it.str.length);
    }
    pages.push(lines);
  }
  const body = [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
  const out: string[] = [];
  let para = '';
  const flush = () => (para && out.push(para.trim()), (para = ''));
  for (const lines of pages) {
    let prevY: number | null = null;
    for (const l of lines) {
      const t = l.text.trim();
      const gap = prevY === null ? 0 : prevY - l.y;
      prevY = l.y;
      const ratio = l.size / body;
      if (ratio >= 1.15 && t.length < 140) {
        flush();
        out.push(`${ratio >= 2 ? '#' : ratio >= 1.5 ? '##' : '###'} ${t}`);
      } else if (/^([•▪◦·●-]|\d+[.)])\s+/.test(t)) {
        flush();
        out.push(t.replace(/^[•▪◦·●]\s+/, '- '));
      } else {
        if (gap > body * 1.9) flush();
        para = para.endsWith('-') && !para.endsWith(' -') ? para.slice(0, -1) + t : para + (para ? ' ' : '') + t;
      }
    }
    flush();
  }
  const md = out.join('\n\n').replace(/\n\n(- )/g, '\n$1');
  if (!md.trim()) throw new Error('No text found. This PDF looks scanned: use the PDF OCR tool first.');
  return md + '\n';
}
