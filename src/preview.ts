import { h } from './ui';

/** Inline preview for any file or result: pictures, audio, video, PDF, text, markdown, HTML, fonts, EPUB and ZIP. */
const ext = (name: string) => name.split('.').pop()!.toLowerCase();
const TEXT = new Set(['txt', 'md', 'markdown', 'html', 'htm', 'svg', 'csv', 'json', 'xml']);
const FONTS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const SNIPPET = 12000;

const pre = (text: string) => h('pre', { class: 'pv-text' }, text.length > SNIPPET ? text.slice(0, SNIPPET) + '\n\n[preview shortened]' : text);

function tabs(panels: [string, HTMLElement][]) {
  const body = h('div', { class: 'pv-tabbody' });
  const bar = h('div', { class: 'pv-tabs', role: 'tablist' });
  const show = (i: number) => {
    body.replaceChildren(panels[i][1]);
    [...bar.children].forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
  };
  panels.forEach(([label], i) => bar.append(h('button', { role: 'tab', onclick: () => show(i) }, label)));
  show(0);
  return h('div', {}, bar, body);
}

async function pdfThumbs(blob: Blob, max = 3) {
  const { openPdf, renderPage } = await import('./lib/pdfjs');
  const pdf = await openPdf(await blob.arrayBuffer());
  const wrap = h('div', { class: 'pv-pages' });
  const n = Math.min(pdf.numPages, max);
  for (let i = 1; i <= n; i++) {
    const { canvas } = await renderPage(pdf, i, 0.9);
    canvas.className = 'pv-page';
    wrap.append(canvas);
  }
  if (pdf.numPages > n) wrap.append(h('p', { class: 'pv-more' }, `${pdf.numPages - n} more pages. Open the file to see them.`));
  return wrap;
}

async function fontSample(blob: Blob) {
  const face = new FontFace('pv-' + Math.random().toString(36).slice(2), await blob.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  const sample = (size: number, text: string) => h('div', { style: `font-family:"${face.family}";font-size:${size}px;line-height:1.2` }, text);
  return h('div', { class: 'pv-font' }, sample(54, 'Aa Gg Rr 123'), sample(22, 'The quick brown fox jumps over the lazy dog.'), sample(14, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz'));
}

async function zipView(blob: Blob) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(blob);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const out = h('div', {}, h('ul', { class: 'pv-list' }, ...names.slice(0, 40).map((n) => h('li', {}, n))));
  const text = names.find((n) => /\.(md|txt|html)$/i.test(n));
  if (text) out.append(pre(await zip.files[text].async('string')));
  const imgs = h('div', { class: 'pv-thumbs' });
  for (const n of names.filter((n) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n)).slice(0, 8)) {
    const b = await zip.files[n].async('blob');
    imgs.append(h('img', { src: URL.createObjectURL(new Blob([b], { type: 'image/' + ext(n).replace('jpg', 'jpeg') })), alt: n }));
  }
  if (imgs.childElementCount) out.append(imgs);
  return out;
}

async function epubView(blob: Blob) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(blob);
  const pages = Object.keys(zip.files).filter((n) => /\.x?html$/i.test(n) && !/nav\./i.test(n)).sort();
  const first = pages[0] ? await zip.files[pages[0]].async('string') : '';
  const text = new DOMParser().parseFromString(first, 'text/html').body.textContent ?? '';
  return h('div', {}, h('p', { class: 'pv-more' }, `${pages.length} chapter file${pages.length === 1 ? '' : 's'}. First one:`), pre(text.replace(/\n{3,}/g, '\n\n').trim()));
}

/** Returns an element previewing `blob`; falls back to a plain message for types that can't be shown. */
export async function preview(blob: Blob, name: string, compact = false): Promise<HTMLElement> {
  const e = ext(name), type = blob.type;
  const url = URL.createObjectURL(blob);
  try {
    if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg'].includes(e)) {
      const img = h('img', { class: 'pv-img', src: url, alt: name });
      if (e !== 'svg') return img;
      return tabs([['Picture', img], ['Code', pre(await blob.text())]]);
    }
    if (type.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv'].includes(e)) return h('video', { class: 'pv-video', src: url, controls: true, preload: 'metadata', muted: true, playsinline: true });
    if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a'].includes(e)) return h('audio', { class: 'pv-audio', src: url, controls: true, preload: 'metadata' });
    if (e === 'pdf') return await pdfThumbs(blob, compact ? 1 : 3);
    if (FONTS.has(e)) return await fontSample(blob);
    if (e === 'docx' || e === 'doc') return h('p', { class: 'pv-more' }, 'Word document. It will be read when you convert it.');
    if (e === 'zip') return await zipView(blob);
    if (e === 'epub') return await epubView(blob);
    if (e === 'md' || e === 'markdown') {
      const src = await blob.text();
      const { mdToHtml } = await import('./lib/docs');
      const rendered = h('div', { class: 'pv-rendered' });
      rendered.innerHTML = (await import('dompurify')).default.sanitize(mdToHtml(src));
      return tabs([['Rendered', rendered], ['Markdown', pre(src)]]);
    }
    if (e === 'html' || e === 'htm') {
      const src = await blob.text();
      const frame = h('iframe', { class: 'pv-frame', sandbox: '', srcdoc: src, title: name });
      return tabs([['Rendered', frame], ['HTML', pre(src)]]);
    }
    if (TEXT.has(e) || type.startsWith('text/')) return pre(await blob.text());
    return h('p', { class: 'pv-more' }, 'No preview for this file type. Download it to open it.');
  } catch (err) {
    console.warn('preview failed', err);
    return h('p', { class: 'pv-more' }, 'Could not build a preview. The file itself is fine to download.');
  }
}
