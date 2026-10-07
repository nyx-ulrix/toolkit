import type { Opt, Tool } from '../types';
import { canvasToBlob, encode, loadImage, toCanvas, traceSvg, type RasterFormat } from '../lib/img';
import { rename } from '../ui';

const FORMATS: Record<string, string> = {
  png: 'PNG', jpg: 'JPG / JPEG', webp: 'WebP', bmp: 'BMP', ico: 'ICO (icon)', svg: 'SVG (traced from pixels)', pdf: 'PDF',
};

/** Image converter and vector converter are the same engine with different defaults. */
export function imageConverter(cfg: { id: string; title: string; desc: string; accept: string; formats: string[]; start: string; maxSide: number; grow?: boolean; note?: string }): Tool {
  return {
    id: cfg.id, group: 'Convert', title: cfg.title, desc: cfg.desc, accept: cfg.accept, note: cfg.note,
    opts: [
      { key: 'format', label: 'Convert to', type: 'select', value: cfg.start, choices: cfg.formats.map((f) => [f, FORMATS[f]]) },
      { key: 'quality', label: 'Quality', type: 'range', value: 0.92, min: 0.1, max: 1, step: 0.01, show: (o) => ['jpg', 'webp', 'pdf'].includes(o.format) },
      { key: 'maxSide', label: 'Longest side (px, 0 = original)', type: 'number', value: cfg.maxSide, min: 0, max: 16000, step: 1 },
      { key: 'bg', label: 'Fill transparent areas with', type: 'color', value: '#ffffff', show: (o) => ['jpg', 'bmp', 'pdf'].includes(o.format) },
      { key: 'colors', label: 'Colours when tracing', type: 'range', value: 16, min: 2, max: 64, step: 1, show: (o) => o.format === 'svg' },
    ] satisfies Opt[],
    async run(file, o, ctx) {
      ctx.progress(0.2, 'Decoding…');
      const img = await loadImage(file);
      const fmt = o.format as RasterFormat;
      const c = toCanvas(img, o.maxSide, ['jpg', 'bmp', 'pdf'].includes(fmt) ? o.bg : undefined, cfg.grow && /svg/i.test(file.type + file.name));
      ctx.progress(0.6, 'Encoding…');
      const blob = fmt === 'svg' ? await traceSvg(c, o.colors) : await encode(c, fmt, o.quality);
      return [{ name: rename(file.name, fmt), blob }];
    },
  };
}

/** Compress PNG / JPG / WebP by re-encoding smaller (and optionally resizing). */
export function imageCompressor(cfg: { id: string; title: string; desc: string; accept: string; start: string }): Tool {
  return {
    id: cfg.id, group: 'Optimize', title: cfg.title, desc: cfg.desc, accept: cfg.accept,
    opts: [
      { key: 'format', label: 'Output format', type: 'select', value: cfg.start, choices: [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP']] },
      { key: 'quality', label: 'Quality', type: 'range', value: 0.75, min: 0.1, max: 1, step: 0.01, show: (o) => o.format !== 'png' },
      { key: 'colors', label: 'PNG palette', type: 'select', value: '256', choices: [['0', 'Lossless (smallest safe)'], ['256', '256 colours (usually 60-70% smaller)'], ['128', '128 colours'], ['64', '64 colours'], ['32', '32 colours']], show: (o) => o.format === 'png' },
      { key: 'maxSide', label: 'Longest side (px, 0 = original)', type: 'number', value: 0, min: 0, max: 16000, step: 1 },
      { key: 'bg', label: 'Fill transparent areas with', type: 'color', value: '#ffffff', show: (o) => o.format === 'jpg' },
    ],
    async run(file, o, ctx) {
      ctx.progress(0.2, 'Decoding…');
      const c = toCanvas(await loadImage(file), o.maxSide, o.format === 'jpg' ? o.bg : undefined);
      ctx.progress(0.6, 'Compressing…');
      let blob: Blob;
      if (o.format === 'png') {
        const { default: UPNG } = await import('upng-js');
        const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        blob = new Blob([UPNG.encode([px.buffer as ArrayBuffer], c.width, c.height, Number(o.colors))], { type: 'image/png' });
      } else {
        blob = await canvasToBlob(c, o.format === 'jpg' ? 'image/jpeg' : 'image/webp', o.quality);
      }
      const sameType = file.type === blob.type;
      if (blob.size >= file.size && sameType && !o.maxSide) return [{ name: file.name, blob: file, note: 'already as small as it gets, kept the original' }];
      return [{ name: rename(file.name, o.format, '-compressed'), blob }];
    },
  };
}

export const imageConvert = imageConverter({
  id: 'image-converter', title: 'Image converter',
  desc: 'Convert between PNG, JPG, WebP, BMP, ICO, SVG and PDF.',
  accept: 'image/*,.svg,.bmp,.ico,.avif', formats: ['png', 'jpg', 'webp', 'bmp', 'ico', 'svg', 'pdf'], start: 'png', maxSide: 0,
  note: 'SVG output traces the picture into coloured vector shapes. It suits logos and flat art better than photos.',
});

export const vectorConvert = imageConverter({
  id: 'vector-converter', title: 'Vector converter',
  desc: 'Turn SVG into PNG, JPG, WebP or PDF at any size, or trace a raster image into SVG.',
  accept: '.svg,image/svg+xml,image/*', formats: ['png', 'jpg', 'webp', 'pdf', 'svg'], start: 'png', maxSide: 2048, grow: true,
  note: 'SVG to PDF is rasterised at the size you choose. EPS, AI and DXF are not supported.',
});

export const compressPng = imageCompressor({
  id: 'compress-png', title: 'Compress PNG', desc: 'Shrink PNG files by reducing the colour palette, with a lossless option.', accept: 'image/png,.png', start: 'png',
});

export const compressJpg = imageCompressor({
  id: 'compress-jpg', title: 'Compress JPG', desc: 'Make JPG photos smaller with a quality slider and optional resize.', accept: 'image/jpeg,.jpg,.jpeg', start: 'jpg',
});
