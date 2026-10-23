import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { pruneAssets } from './tools/pruneAssets';

export default defineConfig({
  main: {
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: { overlay: resolve('src/preload/overlay.ts'), settings: resolve('src/preload/settings.ts'), text: resolve('src/preload/text.ts'), panel: resolve('src/preload/panel.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    publicDir: resolve('assets'),
    plugins: [react(), pruneAssets()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: {
          overlay: resolve('src/renderer/overlay/index.html'),
          settings: resolve('src/renderer/settings/index.html'),
          text: resolve('src/renderer/text/index.html'),
          panel: resolve('src/renderer/panel/index.html'),
        },
      },
    },
  },
});
