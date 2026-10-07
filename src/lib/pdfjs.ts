import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** pdf.js consumes the buffer it is given, so hand it a copy. */
export const openPdf = (data: ArrayBuffer) => pdfjs.getDocument({ data: data.slice(0) }).promise;

/** Render one page to a canvas at `scale` (1 = 72 dpi). The 'print' intent skips requestAnimationFrame, which browsers
 *  freeze in background tabs, so long jobs keep going while the user does something else. */
export async function renderPage(pdf: Awaited<ReturnType<typeof openPdf>>, n: number, scale: number) {
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, intent: 'print' }).promise;
  return { canvas, width: page.getViewport({ scale: 1 }).width, height: page.getViewport({ scale: 1 }).height };
}
