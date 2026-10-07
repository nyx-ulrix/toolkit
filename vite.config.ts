import { defineConfig } from 'vite';

export default defineConfig({
  // ffmpeg.wasm spawns its own module worker; pre-bundling breaks its worker URL.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', 'pdfjs-dist'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { port: 5180 },
});
