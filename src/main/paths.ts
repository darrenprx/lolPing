import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { platformOf, type Platform } from '../shared/platform';
import { APP_SCHEME } from './appProtocol';
import { portableDataDir } from './portable';

export type Page = 'overlay' | 'settings' | 'text' | 'panel' | 'teammate';

export const PLATFORM: Platform = platformOf(process.platform);
export const IS_MAC = PLATFORM === 'mac';
export const IS_LINUX = PLATFORM === 'linux';

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

/**
 * The data folder of a portable build (a `data` folder next to the executable), or null in an installed build.
 * Decided once, before `app.ready`, from the launcher's environment or a `portable.txt` next to the executable.
 */
export const PORTABLE_DATA_DIR: string | null = portableDataDir({ env: process.env, execPath: process.execPath, packaged: app.isPackaged });
export const IS_PORTABLE = PORTABLE_DATA_DIR !== null;

/** Settings, emotes and caches: Electron's appData/lolPing for an installed build, the `data` folder beside a portable one. */
export const settingsDir = (): string => PORTABLE_DATA_DIR ?? join(app.getPath('appData'), 'lolPing');

/** Where `page` is served from: the Vite dev server in development, lolping://app in production. `hash` is without the #. */
export function pageUrl(page: Page, hash = ''): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const suffix = hash ? `#${hash}` : '';
  return devUrl ? `${devUrl}/${page}/index.html${suffix}` : `${APP_SCHEME}://app/${page}/index.html${suffix}`;
}

/** `hash` (without #) is passed to the page, e.g. the settings section to open at. */
export function loadPage(win: BrowserWindow, page: Page, hash = ''): Promise<void> {
  return win.loadURL(pageUrl(page, hash));
}
