import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { pruneAssets } from './tools/pruneAssets';
import { teammateCsp } from './tools/teammateCsp';
import { startupFailureText } from './src/shared/i18n';

export default defineConfig({
  main: {
    plugins: [{ name: 'startup-bootstrap', generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'bootstrap.cjs',
        source: readFileSync(resolve('src/main/bootstrap.cjs'), 'utf8')
          .replace('__BOOTSTRAP_TEXT__', JSON.stringify({ en: startupFailureText.en, zh: startupFailureText['zh-CN'] })) });
    } }],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), bridge: resolve('src/main/mcp/bridge.ts'),
          startupDiagnostics: resolve('src/main/startupDiagnostics.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
        onwarn(warning, warn) {
          // zod (under the MCP SDK) has comments that talk about `@__PURE__`; Rollup only drops them, the code is unchanged.
          if (warning.code === 'INVALID_ANNOTATION' && /[\\/]node_modules[\\/]zod[\\/]/.test(warning.id ?? '')) return;
          warn(warning);
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { overlay: resolve('src/preload/overlay.ts'), settings: resolve('src/preload/settings.ts'), text: resolve('src/preload/text.ts'), panel: resolve('src/preload/panel.ts'), teammate: resolve('src/preload/teammate.ts'), shots: resolve('src/preload/shots.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    publicDir: resolve('assets'),
    plugins: [react(), pruneAssets(), teammateCsp()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve('src/renderer/overlay/index.html'),
          settings: resolve('src/renderer/settings/index.html'),
          text: resolve('src/renderer/text/index.html'),
          panel: resolve('src/renderer/panel/index.html'),
          teammate: resolve('src/renderer/teammate/index.html'),
          shots: resolve('src/renderer/shots/index.html'),
        },
      },
    },
  },
});
