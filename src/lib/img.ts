/** Shared image helpers: decode anything the browser can show, draw it, encode it. */

export type Drawable = { src: CanvasImageSource; w: number; h: number };

/** An <img> decodes SVG as well as rasters (createImageBitmap is flaky for SVG). */
export async function loadImage(file: Blob, fallbackSize = 1024): Promise<Drawable> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    // Not img.decode(): browsers can stall it in a background tab, while load/error events always fire.
    await new Promise((res, rej) => ((img.onload = res), (img.onerror = rej)));
    // SVGs without width/height report 0 in some browsers.
    const w = img.naturalWidth || fallbackSize, h = img.naturalHeight || fallbackSize;
    return { src: img, w, h };
  } catch {
    throw new Error("This browser can't read that image format.");
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Draw with the longest side limited to maxSide (0 = keep size); `grow` also scales smaller images up to it (for vectors).
 *  Optional background fill. */
export function toCanvas(d: Drawable, maxSide = 0, bg?: string, grow = false) {
  const k = maxSide > 0 ? (grow ? maxSide / Math.max(d.w, d.h) : Math.min(1, maxSide / Math.max(d.w, d.h))) : 1;
  const c = canvasOf(d.w * k, d.h * k);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (bg) (ctx.fillStyle = bg), ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(d.src, 0, 0, c.width, c.height);
  return c;
}

export const canvasToBlob = (c: HTMLCanvasElement, type = 'image/png', quality?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, quality));

export type RasterFormat = 'png' | 'jpg' | 'webp' | 'bmp' | 'ico' | 'pdf' | 'svg';

export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', svg: 'image/svg+xml',
};

/** Encode a canvas. `quality` is 0..1 and only matters for jpg/webp. Canvas must already have any background painted. */
export async function encode(c: HTMLCanvasElement, fmt: RasterFormat, quality = 0.92): Promise<Blob> {
  switch (fmt) {
    case 'png': return canvasToBlob(c, 'image/png');
    case 'jpg': return canvasToBlob(c, 'image/jpeg', quality);
    case 'webp': return canvasToBlob(c, 'image/webp', quality);
    case 'bmp': return encodeBmp(c);
    case 'ico': return encodeIco(c);
    case 'pdf': return encodePdf(c, quality);
    case 'svg': return traceSvg(c);
  }
}

function encodeBmp(c: HTMLCanvasElement): Blob {
  const { width: w, height: h } = c;
  const px = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  const row = (w * 3 + 3) & ~3; // rows are padded to 4 bytes
  const buf = new ArrayBuffer(54 + row * h);
  const v = new DataView(buf);
  v.setUint16(0, 0x4d42, true);
  v.setUint32(2, buf.byteLength, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true);
  const out = new Uint8Array(buf);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = 54 + (h - 1 - y) * row + x * 3; // bottom-up, BGR
      out[d] = px[s + 2], out[d + 1] = px[s + 1], out[d + 2] = px[s];
    }
  return new Blob([buf], { type: 'image/bmp' });
}

/** A single-image .ico holding a PNG (supported since Windows Vista); max 256px. */
async function encodeIco(c: HTMLCanvasElement): Promise<Blob> {
  const k = Math.min(1, 256 / Math.max(c.width, c.height));
  const s = canvasOf(c.width * k, c.height * k);
  s.getContext('2d')!.drawImage(c, 0, 0, s.width, s.height);
  const png = new Uint8Array(await (await canvasToBlob(s)).arrayBuffer());
  const head = new DataView(new ArrayBuffer(22));
  head.setUint16(2, 1, true); // type: icon
  head.setUint16(4, 1, true); // one image
  head.setUint8(6, s.width >= 256 ? 0 : s.width);
  head.setUint8(7, s.height >= 256 ? 0 : s.height);
  head.setUint16(10, 1, true);
  head.setUint16(12, 32, true);
  head.setUint32(14, png.length, true);
  head.setUint32(18, 22, true);
  return new Blob([head.buffer, png], { type: 'image/x-icon' });
}

async function encodePdf(c: HTMLCanvasElement, quality: number): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const img = await pdf.embedJpg(new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', quality)).arrayBuffer()));
  pdf.addPage([c.width, c.height]).drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
  return new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' });
}

/** Raster -> SVG by colour tracing (imagetracerjs). Big images are shrunk first to keep it quick. */
export async function traceSvg(c: HTMLCanvasElement, colors = 16): Promise<Blob> {
  const { default: ImageTracer } = await import('imagetracerjs');
  const k = Math.min(1, 1200 / Math.max(c.width, c.height));
  const s = k < 1 ? canvasOf(c.width * k, c.height * k) : c;
  if (s !== c) s.getContext('2d')!.drawImage(c, 0, 0, s.width, s.height);
  const data = s.getContext('2d')!.getImageData(0, 0, s.width, s.height);
  const svg: string = ImageTracer.imagedataToSVG(data, { numberofcolors: colors, scale: 1 / k, viewbox: true, ltres: 1, qtres: 1, pathomit: 8 });
  return new Blob([svg], { type: 'image/svg+xml' });
}
