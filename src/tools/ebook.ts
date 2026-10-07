import type { Tool } from '../types';
import { escapeHtml, htmlToMd, htmlToText, mdToHtml, textToHtml, wrapHtml } from '../lib/docs';
import { rename } from '../ui';

const ext = (f: File) => f.name.split('.').pop()!.toLowerCase();
const parseXml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
/** Resolve `rel` against the folder of `from` inside a zip. */
const resolve = (from: string, rel: string) => {
  const parts = from.split('/').slice(0, -1);
  for (const p of decodeURIComponent(rel.split('#')[0]).split('/')) p === '..' ? parts.pop() : p !== '.' && parts.push(p);
  return parts.join('/');
};

async function readEpub(file: File) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const text = async (p: string) => {
    const f = zip.file(p);
    if (!f) throw new Error('Broken EPUB: missing ' + p);
    return f.async('string');
  };
  const opfPath = parseXml(await text('META-INF/container.xml')).querySelector('rootfile')!.getAttribute('full-path')!;
  const opf = parseXml(await text(opfPath));
  const manifest = new Map([...opf.querySelectorAll('manifest > item')].map((i) => [i.getAttribute('id')!, i.getAttribute('href')!]));
  const title = opf.querySelector('metadata > title, metadata title')?.textContent ?? file.name;
  const chapters: string[] = [];
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const href = manifest.get(ref.getAttribute('idref')!);
    if (!href) continue;
    const doc = new DOMParser().parseFromString(await text(resolve(opfPath, href)), 'text/html');
    chapters.push(doc.body?.innerHTML ?? '');
  }
  return { title, html: chapters.join('\n') };
}

async function writeEpub(title: string, html: string) {
  const { default: JSZip } = await import('jszip');
  // Split at top-level headings so readers get a proper chapter list.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const level = doc.querySelector('h1') ? 'H1' : 'H2';
  const chapters: { title: string; nodes: Element[] }[] = [{ title, nodes: [] }];
  for (const el of [...doc.body.children]) {
    if (el.tagName === level) chapters.push({ title: el.textContent?.trim() || 'Chapter', nodes: [] });
    chapters[chapters.length - 1].nodes.push(el);
  }
  const used = chapters.filter((c) => c.nodes.length);
  const xml = new XMLSerializer();
  const page = (c: { title: string; nodes: Element[] }) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>${escapeHtml(c.title)}</title></head><body>${c.nodes.map((n) => xml.serializeToString(n).replace(/ xmlns="http:\/\/www.w3.org\/1999\/xhtml"/g, '')).join('')}</body></html>`;
  const id = 'urn:uuid:' + crypto.randomUUID();

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  used.forEach((c, i) => zip.file(`OEBPS/ch${i + 1}.xhtml`, page(c)));
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${used.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${escapeHtml(c.title)}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${escapeHtml(title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${used.map((_, i) => `<item id="c${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${used.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

export const ebookConvert: Tool = {
  id: 'ebook-converter', group: 'Convert', title: 'Ebook converter',
  desc: 'EPUB to Markdown, text or HTML, and Markdown, HTML, text or Word to EPUB.',
  accept: '.epub,.md,.markdown,.txt,.html,.htm,.docx',
  note: 'MOBI, AZW3 and KFX (Kindle) are not supported in the browser; convert those to EPUB first (Calibre does this). Images inside EPUBs are not carried over.',
  opts: [{ key: 'format', label: 'Convert to', type: 'select', value: 'epub', choices: [['epub', 'EPUB'], ['md', 'Markdown'], ['txt', 'Plain text'], ['html', 'HTML']] }],
  async run(file, o, ctx) {
    ctx.progress(0.2, 'Reading…');
    const e = ext(file);
    let title = file.name.replace(/\.[^.]+$/, ''), html: string;
    if (e === 'epub') ({ title, html } = { ...(await readEpub(file)) });
    else if (e === 'docx') html = (await (await import('mammoth')).convertToHtml({ arrayBuffer: await file.arrayBuffer() }, { convertImage: (await import('mammoth')).images.imgElement(async () => ({ src: '' })) })).value;
    else if (e === 'md' || e === 'markdown') html = mdToHtml(await file.text());
    else if (e === 'txt') html = textToHtml(await file.text());
    else html = await file.text();

    ctx.progress(0.7, 'Writing…');
    if (o.format === 'epub') return [{ name: rename(file.name, 'epub'), blob: await writeEpub(title, html) }];
    if (o.format === 'md') return [{ name: rename(file.name, 'md'), blob: new Blob([htmlToMd(html)], { type: 'text/markdown' }) }];
    if (o.format === 'txt') return [{ name: rename(file.name, 'txt'), blob: new Blob([htmlToText(html)], { type: 'text/plain' }) }];
    return [{ name: rename(file.name, 'html'), blob: new Blob([wrapHtml(html, title)], { type: 'text/html' }) }];
  },
};
