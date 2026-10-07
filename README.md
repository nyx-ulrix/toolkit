# Toolkit

Browser-only file tools for `toolkit.liewjiaen.com`. Every conversion runs on the visitor's own computer; files are never uploaded, and there is no server code.

```bash
npm install
npm run dev      # http://localhost:5180
npm run build    # typecheck + production build into dist/ (8 MB)
npm run deploy   # build + firebase deploy (project liewjiaen-toolkit, needs `firebase login`)
```

## Tools

| Tool | Engine |
| --- | --- |
| Remove background (AI cutout plus erase and keep brushes, undo, preview, crop, colour fill) | onnxruntime-web (WebGPU, WASM fallback) with U²-Net-P, MODNet or IS-Net |
| Image / vector converter | canvas, imagetracerjs (raster to SVG), pdf-lib (to PDF) |
| Document converter (docx, pdf, html, md, txt) | mammoth, pdf.js, turndown, marked |
| Ebook converter (epub) | JSZip |
| Font converter | fonteditor-core (+ woff2 wasm) |
| Audio / video converter | ffmpeg.wasm (single thread) |
| Compress PNG / JPG | canvas, UPNG (palette quantisation) |
| Compress PDF | pdf-lib (light) or pdf.js + JPEG re-render (strong) |
| PDF OCR | tesseract.js + pdf.js + pdf-lib |
| Image to pixel art, dot matrix & lines | canvas |

Every input and every result has an inline preview (pictures, audio, video, PDF pages, text, rendered Markdown and HTML, fonts, EPUB, ZIP contents), built in `src/preview.ts`. The look is editorial: Cormorant Garamond and Geist (self-hosted via Fontsource), one vermilion accent, square corners, light and dark by system setting.

A tool is one object in `src/tools/*.ts` (`id`, `opts`, `run(file, opts, ctx) => outputs`). `src/ui.ts` builds the page from it and `src/tools/index.ts` lists them. Heavy libraries are imported inside `run()`, so the home page is ~100 KB.

## Hosting and costs

- The site is plain static files on Firebase Hosting (project `liewjiaen-toolkit`, default address https://liewjiaen-toolkit.web.app, custom domain toolkit.liewjiaen.com). The free Spark plan includes 10 GB of storage and about 10 GB of transfer a month; this site is about 9 MB. Config is in `firebase.json` (long caching for hashed assets, no caching for the page).
- Engines too big to ship with the site come from public CDNs, set in `src/config.ts`: the ffmpeg core (31 MB) and onnxruntime wasm (27 MB) from jsDelivr, and the 26 MB / 179 MB cutout models from Hugging Face. `scripts/prune.mjs` removes the onnxruntime wasm that Vite copies into `dist/`. Hosting those yourself would count against the free transfer, so a bucket with free egress (Cloudflare R2) is the better place if you ever want to.

## Licences

All runtime libraries are MIT, BSD, Apache-2.0 or Unlicense. Cutout models are Apache-2.0: U²-Net-P (`public/models/u2netp.onnx`, from BritishWerewolf/U-2-Netp), MODNet (Xenova/modnet) and IS-Net (jellybox/isnet-general-use). `@ffmpeg/core` is GPL-2.0 (it includes x264); it is loaded unmodified from jsDelivr, source at https://github.com/ffmpegwasm/ffmpeg.wasm. Do not add AGPL packages such as `@imgly/background-removal`: serving them to visitors obliges publishing this repo's source.
