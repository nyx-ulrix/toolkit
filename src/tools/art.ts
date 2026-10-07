import type { Tool } from '../types';
import { canvasOf, canvasToBlob, loadImage, toCanvas } from '../lib/img';
import { rename } from '../ui';

type RGB = [number, number, number];
const hex = (s: string): RGB => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;

const FIXED: Record<string, string[]> = {
  gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  bw: ['#000000', '#ffffff'],
  pico8: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
};

/** Median-cut palette of n colours from the opaque pixels. */
function medianCut(px: Uint8ClampedArray, n: number): RGB[] {
  let boxes: RGB[][] = [[]];
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] >= 128) boxes[0].push([px[i], px[i + 1], px[i + 2]]);
  if (!boxes[0].length) return [[0, 0, 0]];
  while (boxes.length < n) {
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes.shift()!;
    if (box.length < 2) { boxes.push(box); break; }
    const ranges = [0, 1, 2].map((ch) => Math.max(...box.map((p) => p[ch])) - Math.min(...box.map((p) => p[ch])));
    const ch = ranges.indexOf(Math.max(...ranges));
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.push(box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((b) => [0, 1, 2].map((ch) => Math.round(b.reduce((s, p) => s + p[ch], 0) / b.length)) as RGB);
}

const nearest = (pal: RGB[], r: number, g: number, b: number) => {
  let best = pal[0], bd = Infinity;
  for (const p of pal) {
    const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
    if (d < bd) (bd = d), (best = p);
  }
  return best;
};

export const pixelArt: Tool = {
  id: 'pixel-art', group: 'Create', title: 'Image to pixel art',
  desc: 'Turn any picture into chunky pixel art with a limited palette.',
  accept: 'image/*',
  opts: [
    { key: 'cells', label: 'Pixels across', type: 'range', value: 64, min: 8, max: 256, step: 1 },
    { key: 'palette', label: 'Palette', type: 'select', value: '16', choices: [['full', 'Full colour'], ['8', '8 colours'], ['16', '16 colours'], ['32', '32 colours'], ['gameboy', 'Game Boy'], ['pico8', 'PICO-8'], ['bw', 'Black & white']] },
    { key: 'dither', label: 'Dithering', type: 'checkbox', value: false, show: (o) => o.palette !== 'full' },
    { key: 'scale', label: 'Upscale to', type: 'select', value: 'big', choices: [['big', 'Large (crisp, ~1024px)'], ['1', '1:1 (tiny)']] },
  ],
  async run(file, o, ctx) {
    ctx.progress(0.2, 'Shrinking…');
    const img = await loadImage(file);
    const w = o.cells, h = Math.max(1, Math.round((img.h / img.w) * w));
    // Drawing in halves keeps the downscale an average rather than a skip.
    let c = toCanvas(img);
    while (c.width / 2 > w) {
      const n = canvasOf(c.width / 2, c.height / 2);
      n.getContext('2d')!.drawImage(c, 0, 0, n.width, n.height);
      c = n;
    }
    const small = canvasOf(w, h);
    const sctx = small.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(c, 0, 0, w, h);
    const data = sctx.getImageData(0, 0, w, h);
    const px = data.data;

    if (o.palette !== 'full') {
      const pal = FIXED[o.palette]?.map(hex) ?? medianCut(px, Number(o.palette));
      const err = new Float32Array(w * h * 3);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (px[i * 4 + 3] < 128) { px[i * 4 + 3] = 0; continue; }
          px[i * 4 + 3] = 255;
          const want = [0, 1, 2].map((k) => Math.max(0, Math.min(255, px[i * 4 + k] + (o.dither ? err[i * 3 + k] : 0))));
          const q = nearest(pal, want[0], want[1], want[2]);
          for (let k = 0; k < 3; k++) px[i * 4 + k] = q[k];
          if (o.dither) {
            // Floyd-Steinberg
            const spread = (dx: number, dy: number, f: number) => {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= w || ny >= h) return;
              for (let k = 0; k < 3; k++) err[(ny * w + nx) * 3 + k] += (want[k] - q[k]) * f;
            };
            spread(1, 0, 7 / 16), spread(-1, 1, 3 / 16), spread(0, 1, 5 / 16), spread(1, 1, 1 / 16);
          }
        }
    }
    sctx.putImageData(data, 0, 0);

    const k = o.scale === 'big' ? Math.max(1, Math.round(1024 / Math.max(w, h))) : 1;
    const out = canvasOf(w * k, h * k);
    const octx = out.getContext('2d')!;
    octx.imageSmoothingEnabled = false;
    octx.drawImage(small, 0, 0, out.width, out.height);
    return [{ name: rename(file.name, 'png', '-pixel'), blob: await canvasToBlob(out) }];
  },
};

type Layer = { ink: string; angle: number; cover: (r: number, g: number, b: number) => number; dx?: number; dy?: number; grain?: boolean };

// Process inks and their conventional screen angles, so the four dot grids interleave instead of clashing.
const CMYK: [string, number, (r: number, g: number, b: number) => number][] = [
  ['#00aeef', 15, (r, g, b) => { const k = 1 - Math.max(r, g, b); return k >= 1 ? 0 : (1 - r - k) / (1 - k); }],
  ['#ec008c', 75, (r, g, b) => { const k = 1 - Math.max(r, g, b); return k >= 1 ? 0 : (1 - g - k) / (1 - k); }],
  ['#fff200', 0, (r, g, b) => { const k = 1 - Math.max(r, g, b); return k >= 1 ? 0 : (1 - b - k) / (1 - k); }],
  ['#231f20', 45, (r, g, b) => 1 - Math.max(r, g, b)],
];

// Risograph ink pairs: a lighter ink for the mid-tones and a second ink for the shadows. Where they overlap, a third colour appears.
const RISO: Record<string, [string, string]> = {
  'pink-blue': ['#ff48b0', '#0078bf'],
  'orange-teal': ['#ff6c2f', '#00838a'],
  'yellow-blue': ['#ffe800', '#0078bf'],
  'sun-green': ['#ffb511', '#00a95c'],
};

export const dotMatrix: Tool = {
  id: 'dot-matrix', group: 'Create', title: 'Image to dot matrix & lines',
  desc: 'Halftone dots or line-engraving from any picture, in full colour, one ink or risograph. Exports SVG (for cutters, plotters, print) and PNG.',
  accept: 'image/*',
  opts: [
    { key: 'mode', label: 'Colour', type: 'select', value: 'full', choices: [['full', 'Full colour (CMYK)'], ['riso', 'Risograph (two inks)'], ['mono', 'One ink']] },
    { key: 'inks', label: 'Riso inks', type: 'select', value: 'pink-blue', choices: [['pink-blue', 'Fluorescent pink and blue'], ['orange-teal', 'Orange and teal'], ['yellow-blue', 'Yellow and blue'], ['sun-green', 'Sunflower and green']], show: (o) => o.mode === 'riso' },
    { key: 'style', label: 'Style', type: 'select', value: 'dots', choices: [['dots', 'Dots (halftone)'], ['lines', 'Lines (engraving)']] },
    { key: 'spacing', label: 'Spacing (px)', type: 'range', value: 10, min: 4, max: 48, step: 1 },
    { key: 'angle', label: 'Angle (°)', type: 'range', value: 45, min: 0, max: 90, step: 1, show: (o) => o.mode === 'mono' },
    { key: 'contrast', label: 'Contrast', type: 'range', value: 1.1, min: 0.5, max: 3, step: 0.1 },
    { key: 'grain', label: 'Ink grain and slight misregistration', type: 'checkbox', value: true, show: (o) => o.mode === 'riso' },
    { key: 'invert', label: 'Light on dark (invert)', type: 'checkbox', value: false, show: (o) => o.mode === 'mono' },
    { key: 'ink', label: 'Ink colour', type: 'color', value: '#111111', show: (o) => o.mode === 'mono' },
    { key: 'paper', label: 'Paper colour', type: 'color', value: '#ffffff' },
    { key: 'transparent', label: 'Transparent paper', type: 'checkbox', value: false },
  ],
  async run(file, o, ctx) {
    ctx.progress(0.2, 'Reading...');
    const c = toCanvas(await loadImage(file), 1600);
    const { width: W, height: H } = c;
    const px = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
    // Average colour (0..1, transparency counted as white paper) in a small box so tiny detail doesn't alias.
    const avg = (x: number, y: number, r: number): [number, number, number] => {
      let R = 0, G = 0, B = 0, n = 0;
      for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(H - 1, Math.floor(y + r)); yy += 2)
        for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(W - 1, Math.floor(x + r)); xx += 2) {
          const i = (yy * W + xx) * 4, a = px[i + 3] / 255;
          R += px[i] * a + 255 * (1 - a), G += px[i + 1] * a + 255 * (1 - a), B += px[i + 2] * a + 255 * (1 - a);
          n++;
        }
      return n ? [R / n / 255, G / n / 255, B / n / 255] : [1, 1, 1];
    };
    const stretch = (v: number) => Math.max(0, Math.min(1, (v - 0.5) * o.contrast + 0.5));
    const dark = (r: number, g: number, b: number) => 1 - (0.299 * r + 0.587 * g + 0.114 * b);
    const s = o.spacing;

    let layers: Layer[];
    if (o.mode === 'full') layers = CMYK.map(([ink, angle, f]) => ({ ink, angle, cover: (r, g, b) => stretch(f(r, g, b)) }));
    else if (o.mode === 'riso') {
      const [a, b] = RISO[o.inks];
      layers = [
        { ink: a, angle: 15, cover: (r, g, bl) => stretch(Math.pow(dark(r, g, bl), 0.55) * 1.15), grain: o.grain },
        { ink: b, angle: 75, cover: (r, g, bl) => stretch(Math.pow(dark(r, g, bl), 1.3) * 1.1), dx: o.grain ? s * 0.18 : 0, dy: o.grain ? -s * 0.12 : 0, grain: o.grain },
      ];
    } else layers = [{ ink: o.ink, angle: o.angle, cover: (r, g, b) => stretch(o.invert ? 1 - dark(r, g, b) : dark(r, g, b)) }];

    const diag = Math.hypot(W, H) / 2, cx = W / 2, cy = H / 2;
    ctx.progress(0.4, 'Drawing...');
    const groups = layers.map((l, li) => {
      const th = (l.angle * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
      const parts: string[] = [];
      const at = (x: number, y: number) => l.cover(...avg(x, y, s / 2));
      if (o.style === 'dots') {
        for (let v = -diag; v <= diag; v += s)
          for (let u = -diag; u <= diag; u += s) {
            const x = cx + u * cos - v * sin, y = cy + u * sin + v * cos;
            if (x < -s || y < -s || x > W + s || y > H + s) continue;
            const r = (s / 2) * 1.05 * Math.sqrt(at(x, y));
            if (r > 0.25) parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}"/>`);
          }
      } else {
        // One filled ribbon per line; its thickness follows the ink coverage underneath.
        for (let v = -diag; v <= diag; v += s) {
          const top: string[] = [], bottom: string[] = [];
          for (let u = -diag; u <= diag; u += 2) {
            const x = cx + u * cos - v * sin, y = cy + u * sin + v * cos;
            if (x < -s || y < -s || x > W + s || y > H + s) continue;
            const t = (s / 2) * 0.95 * at(x, y);
            top.push(`${(x + sin * t).toFixed(1)},${(y - cos * t).toFixed(1)}`);
            bottom.push(`${(x - sin * t).toFixed(1)},${(y + cos * t).toFixed(1)}`);
          }
          if (top.length > 1) parts.push(`<polygon points="${top.join(' ')} ${bottom.reverse().join(' ')}"/>`);
        }
      }
      ctx.progress(0.4 + (0.4 * (li + 1)) / layers.length);
      const move = l.dx || l.dy ? ` transform="translate(${l.dx!.toFixed(1)} ${l.dy!.toFixed(1)})"` : '';
      return `<g fill="${l.ink}" style="mix-blend-mode:multiply"${move}${l.grain ? ' filter="url(#grain)"' : ''}>${parts.join('')}</g>`;
    });

    // Speckle: noise punches small holes in the ink, like an uneven drum print.
    const defs = layers.some((l) => l.grain)
      ? '<defs><filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.6 2.2" result="m"/><feComposite in="SourceGraphic" in2="m" operator="in"/></filter></defs>'
      : '';
    const paper = o.mode === 'riso' && o.paper === '#ffffff' ? '#f7f3ea' : o.paper;
    const bg = o.transparent ? '' : `<rect width="${W}" height="${H}" fill="${paper}"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="isolation:isolate">${defs}${bg}${groups.join('')}</svg>`;
    const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
    ctx.progress(0.85, 'Rendering PNG...');
    const png = toCanvas(await loadImage(svgBlob));
    const tag = o.mode === 'full' ? o.style + '-colour' : o.mode === 'riso' ? o.style + '-riso' : o.style;
    return [
      { name: rename(file.name, 'svg', '-' + tag), blob: svgBlob },
      { name: rename(file.name, 'png', '-' + tag), blob: await canvasToBlob(png) },
    ];
  },
};
