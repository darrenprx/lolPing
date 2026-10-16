import { app, BrowserWindow, nativeImage, nativeTheme, type BrowserWindowConstructorOptions } from 'electron';
import { assetPath, loadPage, preloadPath } from './paths';

let win: BrowserWindow | null = null;
const goneListeners: Array<() => void> = [];

/**
 * Registers `cb` (once, for the app's lifetime) to run whenever the settings window closes or its renderer process
 * dies. The page can't tell the main process that it went away, so anything it left on (like key-capture suspend)
 * has to be released here.
 */
export function onSettingsWindowGone(cb: () => void): void {
  goneListeners.push(cb);
}

const notifyGone = (): void => {
  for (const cb of goneListeners) cb();
};

const captionColors = () => ({
  color: '#00000000',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1a1a1a',
  height: 40,
});

/** Windows 11: Mica with custom caption buttons. */
const chromeOptions = (): BrowserWindowConstructorOptions => ({
  backgroundMaterial: 'mica',
  backgroundColor: '#00000000',
  titleBarStyle: 'hidden',
  titleBarOverlay: captionColors(),
});

export function settingsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function openSettingsWindow(): BrowserWindow {
  const existing = settingsWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  const w = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'lolPing',
    icon: nativeImage.createFromPath(assetPath('textures', 'generic_ping.png')),
    show: false,
    ...chromeOptions(),
    webPreferences: { preload: preloadPath('settings'), spellcheck: false },
  });
  w.removeMenu(); // no menu bar, so pressing Alt in the window does nothing
  const onTheme = () => {
    if (!w.isDestroyed()) w.setTitleBarOverlay(captionColors());
  };
  nativeTheme.on('updated', onTheme);
  w.on('closed', () => {
    nativeTheme.off('updated', onTheme);
    win = null;
    notifyGone();
  });
  w.webContents.on('render-process-gone', notifyGone); // the window can stay open on a dead page
  w.once('ready-to-show', () => {
    app.focus({ steal: true });
    w.show();
  });
  void loadPage(w, 'settings');
  win = w;
  return w;
}
