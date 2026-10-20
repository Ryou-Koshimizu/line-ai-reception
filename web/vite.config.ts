import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 公開デモ（/）と管理画面（/admin/）。静的ファイルとして web/dist に出し、Worker の静的配信か Vercel 等でそのまま出せる
export default defineConfig({
  root: resolve(import.meta.dirname),
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        demo: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
      },
    },
  },
  server: { port: 3106, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { port: 3106, strictPort: true, host: '127.0.0.1' },
});
