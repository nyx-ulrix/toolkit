// Where the big engine files come from. They are downloaded once and cached by the browser; the user's files never
// leave their device. To stop depending on public CDNs, upload the files to your own bucket (e.g. Cloudflare R2 on
// models.liewjiaen.com) and change these URLs.
export const FFMPEG_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
/** onnxruntime-web's wasm engine (27 MB, over Cloudflare's 25 MiB file limit, so it comes from a CDN). Keep the version in
 *  sync with the onnxruntime-web entry in package.json. */
export const ORT_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
/** undefined = tesseract.js default (jsDelivr for the engine, projectnaptha for language data). */
export const TESSERACT_LANG_PATH: string | undefined = undefined;
