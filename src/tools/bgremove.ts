import type { Tool } from '../types';
import { ORT_WASM_PATH } from '../config';
import { canvasOf, canvasToBlob, loadImage, toCanvas } from '../lib/img';
import { rename } from '../ui';

// Three saliency / matting networks, all Apache-2.0 (U²-Net-P, MODNet, IS-Net), run in the browser with
// onnxruntime-web (MIT). U²-Net-P ships with the site (/models); the larger ones download from the Hugging Face hub on
// first use and are cached by the browser.
type Model = { url: string; size: number; mean: number[]; std: number[]; label: string };
const MODELS: Record<string, Model> = {
  fast: { url: '/models/u2netp.onnx', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], label: 'U²-Net-P' },
  portrait: { url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx', size: 512, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], label: 'MODNet' },
  quality: { url: 'https://huggingface.co/jellybox/isnet-general-use/resolve/main/isnet-general-use_1024.onnx', size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], label: 'IS-Net' },
};

type Ort = typeof import('onnxruntime-web');
type Session = import('onnxruntime-web').InferenceSession;
let ort: Promise<Ort> | undefined;
/** Downloaded model bytes and the open session per model; `cpu` marks sessions that fell back from WebGPU. */
const bytesOf = new Map<string, Promise<Uint8Array>>();
const sessions = new Map<string, Promise<Session>>();

function getOrt() {
  ort ??= import('onnxruntime-web').then((o) => {
    o.env.wasm.wasmPaths = ORT_WASM_PATH;
    return o;
  });
  return ort;
}

function getBytes(key: string, onProgress: (f: number) => void) {
  if (!bytesOf.has(key)) {
    bytesOf.set(key, (async () => {
      const res = await fetch(MODELS[key].url);
      if (!res.ok) throw new Error(`Could not download the ${MODELS[key].label} model (${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks: Uint8Array[] = [];
      let got = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total) onProgress(got / total);
      }
      const all = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) (all.set(c, at), (at += c.length));
      return all;
    })().catch((e) => (bytesOf.delete(key), Promise.reject(e))));
  }
  return bytesOf.get(key)!;
}

/** WebGPU first (much faster); the CPU/WASM build if it can't start or can't run the model. */
function getSession(key: string, onProgress: (f: number) => void, cpuOnly = false) {
  const id = key + (cpuOnly ? ':cpu' : '');
  if (!sessions.has(id)) {
    sessions.set(id, (async () => {
      const [o, bytes] = await Promise.all([getOrt(), getBytes(key, onProgress)]);
      for (const ep of !cpuOnly && 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']) {
        try {
          return await o.InferenceSession.create(bytes, { executionProviders: [ep] });
        } catch (e) {
          console.warn(`${ep} session failed`, e);
        }
      }
      throw new Error('This browser could not start the AI model.');
    })().catch((e) => (sessions.delete(id), Promise.reject(e))));
  }
  return sessions.get(id)!;
}

/** Runs the network; returns a size×size mask in 0..255. */
async function predict(key: string, src: HTMLCanvasElement, onProgress: (f: number) => void) {
  const m = MODELS[key];
  const o = await getOrt();
  const s = m.size;
  const small = canvasOf(s, s);
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(src, 0, 0, s, s);
  const px = sctx.getImageData(0, 0, s, s).data;
  const data = new Float32Array(3 * s * s);
  for (let i = 0; i < s * s; i++)
    for (let c = 0; c < 3; c++) data[c * s * s + i] = (px[i * 4 + c] / 255 - m.mean[c]) / m.std[c];
  const input = new o.Tensor('float32', data, [1, 3, s, s]);

  const run = async (cpuOnly: boolean) => {
    const session = await getSession(key, onProgress, cpuOnly);
    const out = await session.run({ [session.inputNames[0]]: input });
    return out[session.outputNames[0]].data as Float32Array;
  };
  let raw: Float32Array;
  try {
    raw = await run(false);
  } catch (e) {
    console.warn('Model run failed, retrying on CPU', e);
    sessions.delete(key);
    raw = await run(true);
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of raw) (v < lo && (lo = v), v > hi && (hi = v));
  const mask = new Uint8ClampedArray(s * s);
  for (let i = 0; i < mask.length; i++) {
    const t = (raw[i] - lo) / (hi - lo || 1);
    mask[i] = Math.max(0, Math.min(1, (t - 0.05) / 0.9)) * 255; // small contrast stretch for cleaner edges
  }
  return mask;
}

export const MODEL_CHOICES: [string, string][] = [['fast', 'Fast: any object (built in)'], ['portrait', 'Portrait: people (26 MB)'], ['quality', 'Best quality: any object (180 MB)']];

/** The AI result as an alpha-only canvas of w x h: opaque where the subject is. */
export async function aiAlpha(key: string, src: HTMLCanvasElement, w: number, h: number, onProgress: (f: number) => void) {
  const s = MODELS[key].size;
  const mask = await predict(key, src, onProgress);
  const mc = canvasOf(s, s);
  const md = mc.getContext('2d')!.createImageData(s, s);
  for (let i = 0; i < mask.length; i++) md.data[i * 4 + 3] = mask[i];
  mc.getContext('2d')!.putImageData(md, 0, 0);
  const out = canvasOf(w, h);
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(mc, 0, 0, w, h);
  return out;
}

/** Keep the original pixels where the mask is opaque. */
function applyMask(img: HTMLCanvasElement, mask: Uint8ClampedArray, s: number) {
  const mc = canvasOf(s, s);
  const mctx = mc.getContext('2d')!;
  const md = mctx.createImageData(s, s);
  for (let i = 0; i < mask.length; i++) md.data[i * 4 + 3] = mask[i];
  mctx.putImageData(md, 0, 0);
  const ctx = img.getContext('2d')!;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mc, 0, 0, img.width, img.height);
  ctx.globalCompositeOperation = 'source-over';
}

/** Smallest box around the non-transparent pixels. */
export function trim(c: HTMLCanvasElement) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 8) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  if (x1 < 0) return c;
  const out = canvasOf(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export const bgRemove: Tool = {
  id: 'remove-background', group: 'Image', title: 'Remove background',
  desc: 'AI cutout that runs on your own computer. Your photo is never uploaded.',
  accept: 'image/*',
  note: 'Fast is built in. Portrait (26 MB) and Best quality (180 MB) download once on first use and stay cached in your browser. A GPU makes the big model much faster.',
  opts: [
    { key: 'model', label: 'Model', type: 'select', value: 'fast', choices: MODEL_CHOICES },
    { key: 'fill', label: 'Background', type: 'select', value: 'transparent', choices: [['transparent', 'Transparent'], ['color', 'Solid colour']] },
    { key: 'color', label: 'Colour', type: 'color', value: '#ffffff', show: (o) => o.fill === 'color' },
    { key: 'crop', label: 'Crop to subject', type: 'checkbox', value: false },
  ],
  async run(file, o, ctx) {
    ctx.progress(0.03, 'Loading model…');
    let c = toCanvas(await loadImage(file), 4096); // keeps huge photos from exhausting memory
    const mask = await predict(o.model, c, (f) => ctx.progress(0.05 + f * 0.7, 'Downloading model…'));
    ctx.progress(0.9, 'Cutting out…');
    applyMask(c, mask, MODELS[o.model].size);
    if (o.crop) c = trim(c);
    if (o.fill === 'color') {
      const f = canvasOf(c.width, c.height);
      const fx = f.getContext('2d')!;
      fx.fillStyle = o.color;
      fx.fillRect(0, 0, f.width, f.height);
      fx.drawImage(c, 0, 0);
      c = f;
    }
    return [{ name: rename(file.name, 'png', '-cutout'), blob: await canvasToBlob(c) }];
  },
};
