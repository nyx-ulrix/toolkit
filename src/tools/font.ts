import type { Tool } from '../types';
import { rename } from '../ui';

const MIME: Record<string, string> = { ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2', eot: 'application/vnd.ms-fontobject', svg: 'image/svg+xml' };

export const fontConvert: Tool = {
  id: 'font-converter', group: 'Convert', title: 'Font converter',
  desc: 'Convert fonts between TTF, OTF, WOFF, WOFF2, EOT and SVG.',
  accept: '.ttf,.otf,.woff,.woff2,.eot,.svg',
  note: 'OTF can be read but not written; OTF input with CFF outlines is converted to TrueType outlines.',
  opts: [{ key: 'format', label: 'Convert to', type: 'select', value: 'woff2', choices: [['woff2', 'WOFF2 (web)'], ['woff', 'WOFF'], ['ttf', 'TTF'], ['eot', 'EOT'], ['svg', 'SVG font']] }],
  async run(file, o, ctx) {
    ctx.progress(0.2, 'Loading font engine…');
    const { Font, woff2 } = await import('fonteditor-core');
    const { default: wasmUrl } = await import('../../node_modules/fonteditor-core/woff2/woff2.wasm?url');
    await woff2.init(wasmUrl);
    const from = file.name.split('.').pop()!.toLowerCase() as 'ttf' | 'otf';
    const font = Font.create(await file.arrayBuffer(), { type: from, hinting: true, compound2simple: from === 'otf' });
    ctx.progress(0.7, 'Writing…');
    const data = font.write({ type: o.format, hinting: true } as any) as BlobPart;
    return [{ name: rename(file.name, o.format), blob: new Blob([data], { type: MIME[o.format] }) }];
  },
};
