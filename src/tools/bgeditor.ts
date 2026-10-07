import type { Tool } from '../types';
import { canvasOf, canvasToBlob, loadImage, toCanvas } from '../lib/img';
import { aiAlpha, MODEL_CHOICES, trim } from './bgremove';
import { download, dropZone, h, pageSignal, rename, toolHeader, xButton } from '../ui';

type Pt = { x: number; y: number };
/** A scribble: where, how wide (mask pixels), what it asks for, and how forgiving the colour match was. */
type Mark = { pts: Pt[]; rad: number; want: 'keep' | 'erase'; tol: number };
type Snap = { a: Uint8ClampedArray; marks: Mark[] };

type Item = {
  file: File;
  url: string;
  state: 'idle' | 'busy' | 'ready' | 'error';
  msg: string;
  removed?: boolean;
  orig?: HTMLCanvasElement; // full resolution (capped at 4096)
  disp?: HTMLCanvasElement; // what the editor draws on screen
  mask?: HTMLCanvasElement; // alpha only: opaque = keep
  px?: ImageData; // the picture at mask size, for edge-aware marking
  ai?: Uint8ClampedArray; // the untouched AI result, for "start over"
  marks: Mark[]; // every scribble so far; replayed whenever the model is run again
  undo: Snap[];
  redo: Snap[];
};

const alphaOf = (c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const a = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
};
const setAlpha = (c: HTMLCanvasElement, a: Uint8ClampedArray) => {
  const g = c.getContext('2d')!;
  const id = g.createImageData(c.width, c.height);
  for (let i = 0; i < a.length; i++) id.data[i * 4 + 3] = a[i];
  g.putImageData(id, 0, 0);
};

// ---- colour maths for edge-aware marking (CIE Lab, so "similar" means similar to the eye) ----
const LIN = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function lab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  out[o] = 116 * y - 16;
  out[o + 1] = 500 * (x - y);
  out[o + 2] = 200 * (y - z);
}
const dist = (a: Float32Array, i: number, b: Float32Array, j: number) => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]);

/** A few representative colours (k-means) of the sampled Lab triples. */
function clusters(samples: number[][], k = 3) {
  const cs = Float32Array.from(Array.from({ length: k }, (_, i) => samples[Math.floor(((i + 0.5) / k) * samples.length)]).flat());
  for (let it = 0; it < 6; it++) {
    const sum = new Float32Array(k * 3), n = new Float32Array(k);
    for (const s of samples) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.hypot(s[0] - cs[c * 3], s[1] - cs[c * 3 + 1], s[2] - cs[c * 3 + 2]);
        if (d < bd) (bd = d), (best = c);
      }
      n[best]++;
      for (let j = 0; j < 3; j++) sum[best * 3 + j] += s[j];
    }
    for (let c = 0; c < k; c++) if (n[c]) for (let j = 0; j < 3; j++) cs[c * 3 + j] = sum[c * 3 + j] / n[c];
  }
  return cs;
}

/** Only the colours that cover a real share of the samples: the dominant background or subject, not stray leftovers. */
function majorClusters(samples: number[][], k: number, share = 0.2) {
  const cs = clusters(samples, k);
  const n = new Array(cs.length / 3).fill(0);
  for (const sm of samples) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < n.length; c++) {
      const d = Math.hypot(sm[0] - cs[c * 3], sm[1] - cs[c * 3 + 1], sm[2] - cs[c * 3 + 2]);
      if (d < bd) (bd = d), (best = c);
    }
    n[best]++;
  }
  const keep = n.map((v, c) => (v / samples.length >= share ? c : -1)).filter((c) => c >= 0);
  return Float32Array.from(keep.flatMap((c) => [cs[c * 3], cs[c * 3 + 1], cs[c * 3 + 2]]));
}

const MASK_SIDE = 2048; // the mask is edited at this size at most; the AI mask is soft anyway
const DISP_SIDE = 1800;
const UNDO_LIMIT = 25;
const HINT = 'Scribble over what to keep or remove. The cutout follows the edges around your mark.';

/** The background remover: AI cutout, then mark what to keep or remove, compare, download. */
export function mountBgEditor(root: HTMLElement, tool: Tool) {
  const items: Item[] = [];
  let cur: Item | undefined;
  let mode: 'erase' | 'keep' = 'erase';
  let size = 40, soft = 40, tol = 30, zoom = 1, exact = false;
  let view = 'result', bgMode = 'transparent', bgColor = '#ffffff', crop = false, fmt = 'png', model = 'fast';
  let compare = false, split = 0.5;

  // ---- stage ----
  const canvas = h('canvas', { class: 'bg-canvas', 'aria-label': 'Cutout preview. Scribble to keep or remove.' });
  const handle = h('div', { class: 'bg-split', role: 'slider', tabindex: 0, hidden: true, 'aria-label': 'Compare original and cutout', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 50 },
    h('span', { class: 'grip' }, '↔'), h('span', { class: 'lab l' }, 'Original'), h('span', { class: 'lab r' }, 'Cutout'));
  const stack = h('div', { class: 'bg-stack' }, canvas, handle);
  const ring = h('div', { class: 'bg-ring', hidden: true });
  const viewport = h('div', { class: 'bg-viewport' }, stack);
  const overlay = h('div', { class: 'bg-overlay' });
  const wrap = h('div', { class: 'bg-wrap' }, viewport, overlay, ring);
  const strip = h('div', { class: 'bg-strip' });
  const drop = dropZone({ accept: 'image/*', title: 'Drop a photo here', hint: 'or click to choose. Several at once works too.', onFiles: addFiles });

  const btn = (label: string, on: () => void, cls = 'btn small') => h('button', { class: cls, onclick: on }, label);
  const eraseBtn = btn('Remove', () => setMode('erase'), 'btn small tool');
  const keepBtn = btn('Keep', () => setMode('keep'), 'btn small tool');
  const undoBtn = btn('Undo', () => step(-1));
  const redoBtn = btn('Redo', () => step(1));
  const resetBtn = btn('Start over', resetMask);
  const compareBtn = btn('Compare', () => setCompare(!compare));
  const dlBtn = h('button', { class: 'btn small primary push', disabled: true, onclick: () => cur && save(cur) }, 'Download');
  const toolbar = h('div', { class: 'bg-toolbar', role: 'toolbar' }, eraseBtn, keepBtn, undoBtn, redoBtn, resetBtn, compareBtn, dlBtn);

  const range = (label: string, min: number, max: number, value: number, on: (v: number) => void) => {
    const out = h('output', { class: 'readout' }, String(value));
    const input = h('input', { type: 'range', min, max, value });
    input.addEventListener('input', () => ((out.textContent = input.value), on(Number(input.value))));
    return h('label', { class: 'field' }, h('span', {}, label), input, out);
  };
  const sizeField = range('Brush size', 8, 200, size, (v) => ((size = v), moveRing()));
  const tolField = range('Edge sensitivity', 8, 80, tol, (v) => (tol = v));
  const softField = range('Edge softness', 0, 100, soft, (v) => (soft = v));
  softField.hidden = true;
  const zoomField = range('Zoom', 100, 400, 100, (v) => ((zoom = v / 100), layout()));

  const select = (label: string, choices: [string, string][], value: string, on: (v: string) => void) => {
    const el = h('select', {}, ...choices.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    el.addEventListener('input', () => on(el.value));
    return h('label', { class: 'field' }, h('span', {}, label), el);
  };
  const check = (label: string, value: boolean, on: (v: boolean) => void) => {
    const el = h('input', { type: 'checkbox', checked: value });
    el.addEventListener('input', () => on(el.checked));
    return h('label', { class: 'field field-check' }, h('span', {}, label), el);
  };
  const colorInput = h('input', { type: 'color', value: bgColor });
  colorInput.addEventListener('input', () => ((bgColor = colorInput.value), paint()));
  const colorField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Colour'), colorInput);
  const redo = btn('Cut out again with this model', () => cur && rerun(cur), 'btn small');
  const dlAll = h('button', { class: 'btn', hidden: true, onclick: saveAll }, 'Download all (.zip)');
  const hint = h('p', { class: 'hint', 'aria-live': 'polite' }, HINT);

  const panel = h('aside', { class: 'panel', 'aria-label': 'Options' },
    h('div', { class: 'opts' },
      hint, sizeField, tolField,
      check('Paint exactly, no edge snapping', exact, (v) => ((exact = v), (softField.hidden = !v), (tolField.hidden = v))),
      softField, zoomField,
      select('Preview', [['result', 'Cutout'], ['original', 'Original'], ['removed', 'Removed area in red']], view, (v) => ((view = v), paint())),
      select('Background', [['transparent', 'Transparent'], ['color', 'Solid colour']], bgMode, (v) => ((bgMode = v), (colorField.hidden = v !== 'color'), paint())),
      colorField,
      check('Crop to subject', crop, (v) => (crop = v)),
      select('Download as', [['png', 'PNG'], ['webp', 'WebP'], ['jpg', 'JPG (solid background)']], fmt, (v) => (fmt = v)),
      select('Model', MODEL_CHOICES, model, (v) => (model = v)),
      redo),
    h('div', { class: 'actions' }, dlAll));

  const stage = h('div', { class: 'stage' });
  root.replaceChildren(toolHeader(tool), h('div', { class: 'workspace' }, stage, panel));

  function syncLayoutShell() {
    const has = items.length > 0;
    drop.classList.toggle('compact', has);
    if (has) {
      strip.replaceChildren(drop, ...items.map(thumb));
      stage.replaceChildren(toolbar, wrap, strip);
    } else {
      stage.replaceChildren(drop);
    }
    panel.classList.toggle('idle', !has);
  }

  function thumb(it: Item) {
    const pick = h('button', { class: `bg-thumb ${it === cur ? 'on' : ''}`, 'aria-label': `Edit ${it.file.name}`, title: it.file.name, onclick: () => select_(it) },
      h('img', { src: it.url, alt: '' }),
      it.state === 'busy' ? h('span', { class: 'tag' }, 'Working') : it.state === 'error' ? h('span', { class: 'tag err' }, 'Failed') : null);
    return h('div', { class: 'bg-thumb-wrap' }, pick, xButton(`Remove ${it.file.name} from this page`, () => removeItem(it)));
  }

  // ---- state ----
  function addFiles(files: File[]) {
    for (const f of files.filter((f) => f.type.startsWith('image/'))) items.push({ file: f, url: URL.createObjectURL(f), state: 'idle', msg: 'Waiting', marks: [], undo: [], redo: [] });
    if (!cur) cur = items[0];
    syncLayoutShell();
    show();
    void pump();
  }

  function select_(it: Item) {
    cur = it;
    syncLayoutShell();
    show();
  }

  function removeItem(it: Item) {
    it.removed = true;
    const i = items.indexOf(it);
    items.splice(i, 1);
    URL.revokeObjectURL(it.url);
    if (cur === it) cur = items[Math.min(i, items.length - 1)];
    syncLayoutShell();
    if (cur) show();
    else {
      marks = null;
      hint.textContent = HINT;
    }
  }

  let working = false;
  async function pump() {
    if (working) return;
    working = true;
    for (const it of [...items]) if (it.state === 'idle' && !it.removed) await process(it);
    working = false;
  }

  async function process(it: Item) {
    it.state = 'busy';
    it.msg = 'Preparing...';
    refresh(it);
    try {
      const img = await loadImage(it.file);
      it.orig ??= toCanvas(img, 4096);
      const k = Math.min(1, MASK_SIDE / Math.max(it.orig.width, it.orig.height));
      const dk = Math.min(1, DISP_SIDE / Math.max(it.orig.width, it.orig.height));
      if (!it.disp) {
        it.disp = canvasOf(it.orig.width * dk, it.orig.height * dk);
        it.disp.getContext('2d')!.drawImage(it.orig, 0, 0, it.disp.width, it.disp.height);
      }
      it.mask = await aiAlpha(model, it.orig, Math.round(it.orig.width * k), Math.round(it.orig.height * k), (f) => ((it.msg = `Downloading model ${Math.round(f * 100)}%`), it === cur && showMsg(it.msg)));
      it.ai = alphaOf(it.mask);
      // The model takes your scribbles into account: every earlier mark is applied again on top of the fresh result.
      for (const m of it.marks) applyMark(it, m);
      it.undo = [];
      it.redo = [];
      it.state = 'ready';
    } catch (e) {
      console.error(e);
      it.state = 'error';
      it.msg = e instanceof Error ? e.message : String(e);
    }
    if (!it.removed) refresh(it);
  }

  async function rerun(it: Item) {
    if (it.state === 'busy') return;
    await process(it);
  }

  function refresh(it: Item) {
    syncLayoutShell();
    if (it === cur) show();
  }

  function showMsg(text: string) {
    overlay.hidden = false;
    overlay.replaceChildren(h('p', {}, text));
  }

  function show() {
    const it = cur;
    const ready = it?.state === 'ready';
    wrap.classList.toggle('empty', !ready);
    for (const b of [undoBtn, redoBtn, resetBtn, compareBtn, eraseBtn, keepBtn, dlBtn, redo]) b.disabled = !ready;
    undoBtn.disabled = !ready || !it!.undo.length;
    redoBtn.disabled = !ready || !it!.redo.length;
    dlAll.hidden = items.filter((i) => i.state === 'ready').length < 2;
    eraseBtn.setAttribute('aria-pressed', String(mode === 'erase'));
    keepBtn.setAttribute('aria-pressed', String(mode === 'keep'));
    if (!it) return;
    if (it.state === 'busy') return showMsg(it.msg + (it.msg.startsWith('Download') ? '' : '. The first run downloads the model.'));
    if (it.state === 'error') {
      overlay.hidden = false;
      overlay.replaceChildren(h('p', {}, 'Could not cut this one out: ' + it.msg), h('button', { class: 'btn small', onclick: () => rerun(it) }, 'Try again'));
      return;
    }
    if (it.state === 'idle') return showMsg('Waiting for its turn...');
    overlay.hidden = true;
    canvas.width = it.disp!.width;
    canvas.height = it.disp!.height;
    layout();
    paint();
  }

  /** Fit the picture to the stage, then apply zoom. */
  function layout() {
    if (!cur?.disp) return;
    const maxW = viewport.clientWidth || 640, maxH = Math.max(320, Math.min(window.innerHeight * 0.68, 760));
    const fit = Math.min(maxW / canvas.width, maxH / canvas.height, 1.5);
    canvas.style.width = `${canvas.width * fit * zoom}px`;
    canvas.style.height = `${canvas.height * fit * zoom}px`;
    viewport.style.maxHeight = `${maxH}px`;
    moveRing();
  }
  new ResizeObserver(() => layout()).observe(viewport);

  // ---- compare slider ----
  function setCompare(on: boolean) {
    compare = on;
    handle.hidden = !on;
    compareBtn.setAttribute('aria-pressed', String(on));
    placeHandle();
    paint();
  }
  function placeHandle() {
    handle.style.left = `${split * 100}%`;
    handle.setAttribute('aria-valuenow', String(Math.round(split * 100)));
  }
  function moveSplit(clientX: number) {
    const r = stack.getBoundingClientRect();
    split = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    placeHandle();
    paint();
  }
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    moveSplit(e.clientX);
    const move = (ev: PointerEvent) => moveSplit(ev.clientX);
    const up = () => (handle.removeEventListener('pointermove', move), handle.removeEventListener('pointerup', up), handle.removeEventListener('pointercancel', up));
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      split = Math.max(0, Math.min(1, split + (e.key === 'ArrowRight' ? 0.03 : -0.03)));
      placeHandle();
      paint();
      e.preventDefault();
    }
  });

  // ---- drawing the preview ----
  let raf = 0;
  const tmp = canvasOf(1, 1);
  // Background tabs freeze requestAnimationFrame, so draw straight away there.
  const paint = () => (document.hidden ? draw() : (raf ||= requestAnimationFrame(() => ((raf = 0), draw()))));
  let marks: { pts: Pt[]; rad: number } | null = null; // the scribble being drawn, in mask pixels

  function draw() {
    const it = cur;
    if (!it?.disp || !it.mask || it.state !== 'ready') return;
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    g.drawImage(it.disp, 0, 0);
    if (view === 'removed') {
      tmp.width = W;
      tmp.height = H;
      const t = tmp.getContext('2d')!;
      t.fillStyle = 'rgba(216, 56, 28, 0.62)';
      t.fillRect(0, 0, W, H);
      t.globalCompositeOperation = 'destination-out';
      t.drawImage(it.mask, 0, 0, W, H);
      g.drawImage(tmp, 0, 0);
    } else if (view === 'result') {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(it.mask, 0, 0, W, H);
      if (bgMode === 'color') {
        g.globalCompositeOperation = 'destination-over';
        g.fillStyle = bgColor;
        g.fillRect(0, 0, W, H);
      }
      g.globalCompositeOperation = 'source-over';
    }
    if (compare) {
      g.save();
      g.beginPath();
      g.rect(0, 0, split * W, H);
      g.clip();
      g.clearRect(0, 0, W, H);
      g.drawImage(it.disp, 0, 0);
      g.restore();
    }
    if (marks) {
      const sx = W / it.mask.width;
      g.lineCap = g.lineJoin = 'round';
      const path = () => {
        g.beginPath();
        marks!.pts.forEach((p, i) => (i ? g.lineTo(p.x * sx, p.y * sx) : g.moveTo(p.x * sx, p.y * sx)));
        if (marks!.pts.length === 1) g.lineTo(marks!.pts[0].x * sx + 0.01, marks!.pts[0].y * sx);
      };
      g.lineWidth = marks.rad * 2 * sx + 3;
      g.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      path();
      g.stroke();
      g.lineWidth = marks.rad * 2 * sx;
      g.strokeStyle = mode === 'erase' ? 'rgba(216, 56, 28, 0.6)' : 'rgba(255, 255, 255, 0.7)';
      path();
      g.stroke();
    }
  }

  // ---- marking ----
  let drawing = false;
  let last: Pt | null = null;

  function toMask(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    const k = cur!.mask!.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * (cur!.mask!.height / r.height), k };
  }

  /** Exact painting: a soft round brush stamped straight into the mask. */
  function stamp(x: number, y: number, rad: number) {
    const g = cur!.mask!.getContext('2d')!;
    const grad = g.createRadialGradient(x, y, Math.min(rad * (1 - soft / 100), rad - 0.01), x, y, rad);
    const c = mode === 'erase' ? '0,0,0' : '255,255,255';
    grad.addColorStop(0, `rgba(${c},1)`);
    grad.addColorStop(1, `rgba(${c},0)`);
    g.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }

  function strokeExact(e: PointerEvent) {
    const { x, y, k } = toMask(e);
    const rad = (size / 2) * k;
    const from = last ?? { x, y };
    const n = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / Math.max(1, rad * 0.25)));
    for (let i = 1; i <= n; i++) stamp(from.x + ((x - from.x) * i) / n, from.y + ((y - from.y) * i) / n, rad);
    last = { x, y };
    paint();
  }

  function maskPixels(it: Item) {
    if (!it.px) {
      const c = canvasOf(it.mask!.width, it.mask!.height);
      c.getContext('2d')!.drawImage(it.orig!, 0, 0, c.width, c.height);
      it.px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    }
    return it.px;
  }

  /**
   * A mark is a hint, not a paint stroke. Colours under the mark that already match the wanted state are the example;
   * the cutout then spreads to connected neighbours of similar colour, stopping at edges, and ignores the rest of the
   * area under the mark. Returns false when nothing under the mark looked like the example.
   */
  function applyMark(it: Item, m: Mark) {
    const { pts, rad, want, tol: tolerance } = m;
    const mask = it.mask!, W = mask.width, H = mask.height, px = maskPixels(it).data;
    const alpha = mask.getContext('2d')!.getImageData(0, 0, W, H).data;
    const pad = Math.max(rad * 2.5, 48);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - rad - pad)), x1 = Math.min(W, Math.ceil(Math.max(...xs) + rad + pad));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - rad - pad)), y1 = Math.min(H, Math.ceil(Math.max(...ys) + rad + pad));
    const bw = x1 - x0, bh = y1 - y0;

    // where the mark is
    const sc = canvasOf(bw, bh), sg = sc.getContext('2d')!;
    sg.lineCap = sg.lineJoin = 'round';
    sg.lineWidth = rad * 2;
    sg.strokeStyle = '#fff';
    sg.beginPath();
    pts.forEach((p, i) => (i ? sg.lineTo(p.x - x0, p.y - y0) : sg.moveTo(p.x - x0, p.y - y0)));
    if (pts.length === 1) sg.lineTo(pts[0].x - x0 + 0.01, pts[0].y - y0);
    sg.stroke();
    const sd = sg.getImageData(0, 0, bw, bh).data;

    // Lab colours of the window
    const L = new Float32Array(bw * bh * 3);
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        const s = ((y + y0) * W + x + x0) * 4;
        lab(px[s], px[s + 1], px[s + 2], L, (y * bw + x) * 3);
      }

    // Example colours come from under the mark. Colours that look like the area we do NOT want to change (the other
    // state, sampled around the mark) are left out, so a sloppy scribble that touches the background doesn't grab it.
    const stateOf = (i: number) => alpha[((Math.floor(i / bw) + y0) * W + (i % bw) + x0) * 4 + 3] >= 128; // true = kept
    const seeds: number[] = [], others: number[] = [];
    for (let i = 0; i < bw * bh; i++) {
      if (sd[i * 4 + 3] > 127) seeds.push(i);
      else if (stateOf(i) !== (want === 'keep')) others.push(i);
    }
    if (!seeds.length) return false;
    const sample = (idx: number[]) => {
      const stride = Math.max(1, Math.floor(idx.length / 3000));
      const out: number[][] = [];
      for (let i = 0; i < idx.length; i += stride) out.push([L[idx[i] * 3], L[idx[i] * 3 + 1], L[idx[i] * 3 + 2]]);
      return out;
    };
    const oppSamples = sample(others);
    const ocs = oppSamples.length >= 20 ? majorClusters(oppSamples, 4) : new Float32Array(0);
    const no = ocs.length / 3;
    const dOpp = (i: number) => {
      let d = Infinity;
      for (let c = 0; c < no; c++) d = Math.min(d, dist(L, i * 3, ocs, c * 3));
      return d;
    };
    const samples = sample(seeds);
    let cs = clusters(samples, Math.min(3, samples.length));
    {
      // k-means splits one flat colour into several near-identical centres; fold those back together
      const centres: number[][] = [];
      for (let c = 0; c < cs.length / 3; c++) {
        const v = [cs[c * 3], cs[c * 3 + 1], cs[c * 3 + 2]];
        if (!centres.some((u) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]) < tolerance * 0.5)) centres.push(v);
      }
      cs = Float32Array.from(centres.flat());
    }
    let avoid = false; // true when the mark brushed the other area too, so the spread must stay out of it
    if (no) {
      const k = cs.length / 3, share = new Array(k).fill(0), like: boolean[] = [];
      for (const sm of samples) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = Math.hypot(sm[0] - cs[c * 3], sm[1] - cs[c * 3 + 1], sm[2] - cs[c * 3 + 2]);
          if (d < bd) (bd = d), (best = c);
        }
        share[best]++;
      }
      for (let c = 0; c < k; c++) {
        let d = Infinity;
        for (let o = 0; o < no; o++) d = Math.min(d, Math.hypot(cs[c * 3] - ocs[o * 3], cs[c * 3 + 1] - ocs[o * 3 + 1], cs[c * 3 + 2] - ocs[o * 3 + 2]));
        like[c] = d <= tolerance * 0.8;
      }
      // Drop look-alikes of the other area unless they are most of what was marked (a deliberate mark on a subject part).
      const keepIdx = [...Array(k).keys()].filter((c) => !like[c] || share[c] / samples.length >= 0.5);
      avoid = keepIdx.length < k;
      if (!keepIdx.length) return false;
      cs = Float32Array.from(keepIdx.flatMap((c) => [cs[c * 3], cs[c * 3 + 1], cs[c * 3 + 2]]));
    }
    const nc = cs.length / 3;
    let spread = 0;
    for (const sm of samples) {
      let d = Infinity;
      for (let c = 0; c < nc; c++) d = Math.min(d, Math.hypot(sm[0] - cs[c * 3], sm[1] - cs[c * 3 + 1], sm[2] - cs[c * 3 + 2]));
      spread += d < tolerance * 2 ? d : 0;
    }
    const T = tolerance + Math.min(15, (spread / samples.length) * 1.2), Tstep = tolerance * 0.55 + 3;
    const near = (i: number) => {
      let d = Infinity;
      for (let c = 0; c < nc; c++) d = Math.min(d, dist(L, i * 3, cs, c * 3));
      return d;
    };
    const accept = (i: number) => {
      const d = near(i);
      return d <= T && (!avoid || d <= dOpp(i));
    };

    // spread from the mark's matching pixels, across similar colour, without crossing sharp edges
    const region = new Uint8Array(bw * bh), queue = new Int32Array(bw * bh);
    let qh = 0, qt = 0;
    for (const i of seeds) if (accept(i)) ((region[i] = 1), (queue[qt++] = i));
    if (!qt) return false;
    while (qh < qt) {
      const p = queue[qh++], x = p % bw, y = (p / bw) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < bw - 1 ? p + 1 : -1, y > 0 ? p - bw : -1, y < bh - 1 ? p + bw : -1]) {
        if (q < 0 || region[q]) continue;
        if (dist(L, q * 3, L, p * 3) <= Tstep && accept(q)) ((region[q] = 1), (queue[qt++] = q));
      }
    }

    // apply with a slightly feathered edge
    const rc = canvasOf(bw, bh), rg = rc.getContext('2d')!;
    const rd = rg.createImageData(bw, bh);
    for (let i = 0; i < region.length; i++) if (region[i]) rd.data[i * 4 + 3] = 255;
    rg.putImageData(rd, 0, 0);
    const fc = canvasOf(bw, bh);
    const fg = fc.getContext('2d')!;
    fg.filter = 'blur(1.2px)';
    fg.drawImage(rc, 0, 0);
    const g = mask.getContext('2d')!;
    g.globalCompositeOperation = want === 'keep' ? 'source-over' : 'destination-out';
    g.drawImage(fc, x0, y0);
    g.globalCompositeOperation = 'source-over';
    return true;
  }

  const snap = (it: Item): Snap => ({ a: alphaOf(it.mask!), marks: it.marks.slice() });
  function pushUndo() {
    const it = cur!;
    it.undo.push(snap(it));
    if (it.undo.length > UNDO_LIMIT) it.undo.shift();
    it.redo = [];
  }

  function step(dir: -1 | 1) {
    const it = cur;
    if (!it?.mask) return;
    const from = dir < 0 ? it.undo : it.redo, to = dir < 0 ? it.redo : it.undo;
    const target = from.pop();
    if (!target) return;
    to.push(snap(it));
    setAlpha(it.mask, target.a);
    it.marks = target.marks;
    show();
  }

  function resetMask() {
    const it = cur;
    if (!it?.mask || !it.ai) return;
    pushUndo();
    setAlpha(it.mask, it.ai);
    it.marks = [];
    show();
  }

  function setMode(m: 'erase' | 'keep') {
    mode = m;
    eraseBtn.setAttribute('aria-pressed', String(m === 'erase'));
    keepBtn.setAttribute('aria-pressed', String(m === 'keep'));
    ring.dataset.mode = m;
  }

  // The brush ring is the cursor: same centre and same diameter as the mark it leaves.
  let pointer: Pt | null = null;
  function moveRing() {
    if (!pointer) return (ring.hidden = true);
    const r = wrap.getBoundingClientRect();
    ring.hidden = false;
    ring.style.width = ring.style.height = `${size}px`;
    ring.style.transform = `translate(${pointer.x - r.left - size / 2}px, ${pointer.y - r.top - size / 2}px)`;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || cur?.state !== 'ready') return;
    canvas.setPointerCapture(e.pointerId);
    pushUndo();
    drawing = true;
    last = null;
    if (exact) return strokeExact(e);
    const { x, y, k } = toMask(e);
    marks = { pts: [{ x, y }], rad: (size / 2) * k };
    paint();
  });
  canvas.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    moveRing();
    if (!drawing) return;
    if (exact) return strokeExact(e);
    const { x, y } = toMask(e);
    const p = marks!.pts[marks!.pts.length - 1];
    if (Math.hypot(x - p.x, y - p.y) >= 1.5) (marks!.pts.push({ x, y }), paint());
  });
  const end = () => {
    if (!drawing) return;
    drawing = false;
    last = null;
    if (!exact && marks && cur?.mask) {
      const it = cur;
      const m: Mark = { pts: marks.pts, rad: marks.rad, want: mode, tol };
      if (applyMark(it, m)) {
        it.marks.push(m);
        hint.textContent = HINT;
      } else {
        it.undo.pop();
        hint.textContent = 'Nothing under that mark looked like the part you want. Try a larger sensitivity or mark a clearer area.';
      }
    }
    marks = null;
    show();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => ((pointer = null), moveRing()));

  addEventListener('keydown', (e) => {
    if (!cur || (e.target as HTMLElement)?.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') (e.preventDefault(), step(e.shiftKey ? 1 : -1));
    else if ((e.ctrlKey || e.metaKey) && k === 'y') (e.preventDefault(), step(1));
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (k === 'r') setMode('erase');
    else if (k === 'k') setMode('keep');
    else if (k === 'c') setCompare(!compare);
    else if (k === '[' || k === ']') {
      size = Math.max(8, Math.min(200, size + (k === ']' ? 8 : -8)));
      (sizeField.querySelector('input') as HTMLInputElement).value = String(size);
      sizeField.querySelector('output')!.textContent = String(size);
      moveRing();
    }
  }, { signal: pageSignal() });

  // ---- output ----
  async function build(it: Item) {
    let c = canvasOf(it.orig!.width, it.orig!.height);
    const g = c.getContext('2d')!;
    g.drawImage(it.orig!, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.imageSmoothingQuality = 'high';
    g.drawImage(it.mask!, 0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    if (crop) c = trim(c);
    if (bgMode === 'color' || fmt === 'jpg') {
      const f = canvasOf(c.width, c.height);
      const fx = f.getContext('2d')!;
      fx.fillStyle = bgMode === 'color' ? bgColor : '#ffffff';
      fx.fillRect(0, 0, f.width, f.height);
      fx.drawImage(c, 0, 0);
      c = f;
    }
    const blob = fmt === 'png' ? await canvasToBlob(c) : await canvasToBlob(c, fmt === 'jpg' ? 'image/jpeg' : 'image/webp', 0.92);
    return { blob, name: rename(it.file.name, fmt, '-cutout') };
  }
  async function save(it: Item) {
    const { blob, name } = await build(it);
    download(blob, name);
  }
  async function saveAll() {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const it of items.filter((i) => i.state === 'ready')) {
      const { blob, name } = await build(it);
      zip.file(name, blob);
    }
    download(await zip.generateAsync({ type: 'blob' }), 'cutouts.zip');
  }

  setMode('erase');
  syncLayoutShell();
}
