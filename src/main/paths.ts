import { app, type BrowserWindow } from 'electron';
import { join, resolve } from 'node:path';
import { platformOf, type Platform } from '../shared/platform';
import { APP_SCHEME } from './appProtocol';
import { writeDiagnostic } from './diagnostics';

export type Page = 'overlay' | 'settings' | 'text' | 'panel' | 'teammate' | 'shots';

export const PLATFORM: Platform = platformOf(process.platform);
export const IS_MAC = PLATFORM === 'mac';
export const IS_LINUX = PLATFORM === 'linux';
/** Isolated regression runs may render native windows without showing them; ignored in installed builds. */
export const HIDDEN_TEST_RUN = !app.isPackaged && process.env.LOLPING_HIDDEN_TEST === '1';

const HELPER_FILE = PLATFORM === 'win' ? 'hook-helper.exe' : 'hook-helper';
const CONTEXT_HELPER_FILE = PLATFORM === 'win' ? 'context-helper.exe' : 'context-helper';

export const helperExePath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, HELPER_FILE)
    : join(app.getAppPath(), 'native', 'hook-helper', 'build', HELPER_FILE);

/** The teammate's screen capture helper. Not built on Linux, where the teammate is hidden. */
export const contextHelperPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, CONTEXT_HELPER_FILE)
    : join(app.getAppPath(), 'native', 'hook-helper', 'build', CONTEXT_HELPER_FILE);

/** Files from build/ that ship as extraResources (the macOS menu bar icon). */
export const buildResourcePath = (file: string): string =>
  app.isPackaged ? join(process.resourcesPath, file) : join(app.getAppPath(), 'build', file);

export const preloadPath = (name: Page): string => join(__dirname, '../preload', `${name}.js`);

/** Files from assets/ (in production they are copied into out/renderer by Vite's publicDir). */
export const assetPath = (...parts: string[]): string =>
  app.isPackaged ? join(__dirname, '../renderer', ...parts) : join(app.getAppPath(), 'assets', ...parts);

export const settingsDir = (): string => !app.isPackaged && process.env.LOLPING_TEST_SETTINGS
  ? resolve(process.env.LOLPING_TEST_SETTINGS) : join(app.getPath('appData'), 'lolPing');

/** Where `page` is served from: the Vite dev server in development, lolping://app in production. `hash` is without the #. */
export function pageUrl(page: Page, hash = ''): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const suffix = hash ? `#${hash}` : '';
  return devUrl ? `${devUrl}/${page}/index.html${suffix}` : `${APP_SCHEME}://app/${page}/index.html${suffix}`;
}

/** `hash` (without #) is passed to the page, e.g. the settings section to open at. */
export function loadPage(win: BrowserWindow, page: Page, hash = ''): Promise<void> {
  writeDiagnostic('page-request', { window: win.id, page });
  return win.loadURL(pageUrl(page, hash));
}
