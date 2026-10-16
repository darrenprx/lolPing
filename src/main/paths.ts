import { app, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platformOf, type Platform } from '../shared/platform';
import { APP_SCHEME } from './appProtocol';

export type Page = 'overlay' | 'settings';

export const PLATFORM: Platform = platformOf(process.platform);

const CPP_HELPER_FILE = 'hook-helper.exe';
const RUST_HELPER_FILE = 'lolping-helper.exe';

/** Rust-port binary locations, most-preferred first (release, then debug for local dev). */
const rustHelperCandidates = (): string[] =>
  app.isPackaged
    ? [join(process.resourcesPath, RUST_HELPER_FILE)]
    : [
        join(app.getAppPath(), 'native', 'rust-helper', 'target', 'release', RUST_HELPER_FILE),
        join(app.getAppPath(), 'native', 'rust-helper', 'target', 'debug', RUST_HELPER_FILE),
      ];

const cppHelperPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, CPP_HELPER_FILE)
    : join(app.getAppPath(), 'native', 'hook-helper', 'build', CPP_HELPER_FILE);

/**
 * Resolve the input-helper binary. Prefers the Rust port when it is present (packaged, or
 * built locally) and falls back to the C++ helper. Both speak the same JSON-lines protocol,
 * so InputBridge needs no other change. Set LOLPING_HELPER=cpp to force the C++ helper.
 */
export const helperExePath = (): string => {
  if ((process.env.LOLPING_HELPER ?? '').toLowerCase() !== 'cpp') {
    for (const p of rustHelperCandidates()) {
      if (existsSync(p)) return p;
    }
  }
  return cppHelperPath();
};

/** Files from build/ that ship as extraResources. */
export const buildResourcePath = (file: string): string =>
  app.isPackaged ? join(process.resourcesPath, file) : join(app.getAppPath(), 'build', file);

export const preloadPath = (name: Page): string => join(__dirname, '../preload', `${name}.js`);

/** Files from assets/ (in production they are copied into out/renderer by Vite's publicDir). */
export const assetPath = (...parts: string[]): string =>
  app.isPackaged ? join(__dirname, '../renderer', ...parts) : join(app.getAppPath(), 'assets', ...parts);

export const settingsDir = (): string => join(app.getPath('appData'), 'lolPing');

export function loadPage(win: BrowserWindow, page: Page): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return devUrl ? win.loadURL(`${devUrl}/${page}/index.html`) : win.loadURL(`${APP_SCHEME}://app/${page}/index.html`);
}
