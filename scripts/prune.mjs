// Cloudflare static assets cap single files at 25 MiB. onnxruntime-web's 27 MB wasm gets emitted into dist/ but is never
// requested (transformers.js loads it from jsDelivr), so drop it.
import { readdirSync, rmSync } from 'node:fs';
for (const f of readdirSync('dist/assets')) if (/^ort-.*\.wasm$/.test(f)) (rmSync(`dist/assets/${f}`), console.log('pruned', f));
