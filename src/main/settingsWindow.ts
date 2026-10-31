import { app, BrowserWindow, nativeImage, nativeTheme, type BrowserWindowConstructorOptions } from 'electron';
import { LOGO_TEXTURE } from '../shared/pings';
import { SETTINGS_CH } from '../shared/settingsChannels';
import { assetPath, IS_LINUX, IS_MAC, loadPage, pageUrl, preloadPath } from './paths';

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

/** Windows 11: Mica with custom caption buttons. macOS: sidebar vibrancy with inset traffic lights. */
const chromeOptions = (): BrowserWindowConstructorOptions => (IS_MAC
  ? {
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 19 },
  }
  : IS_LINUX ? {
    frame: true, // use the desktop's native close/minimize/maximize controls
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
  } : {
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: captionColors(),
  });

/** lolPing lives in the macOS menu bar: it only has a Dock icon (and ⌘-Tab entry) while settings are open. */
function showInDock(on: boolean): void {
  if (!IS_MAC) return;
  if (on) {
    void app.dock?.show();
    app.focus({ steal: true });
  } else {
    app.dock?.hide();
  }
}

/**
 * Whether `url` is the settings page itself, whatever follows its address (a reload is the only navigation this window
 * needs). The page can import and remove files through its preload, so nothing else may ever load into it.
 */
function isSettingsPage(url: string): boolean {
  try {
    const target = new URL(url);
    const own = new URL(pageUrl('settings'));
    return target.protocol === own.protocol && target.host === own.host && target.pathname === own.pathname;
  } catch {
    return false; // not a URL at all
  }
}

export function settingsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/**
 * macOS can drop the sidebar vibrancy across a Dock minimize/restore (whatever the Dock animation), leaving the nav
 * column unfilled — the page paints nothing there, so the material itself has to be rebuilt. Called from both the
 * restore event and the reopen path below: the event is the safety net for a native deminiaturize, the direct call
 * covers reopening through the tray or the Dock icon, where restore() runs but has been seen not to emit the event.
 */
function reviveVibrancy(w: BrowserWindow): void {
  w.setVibrancy(null);
  w.setVibrancy('sidebar');
}

/**
 * The Dock genie/scale animation warps the window's last rendered frame, and the nav column in that frame is fully
 * transparent — the vibrancy material lives behind the page, not in it, so the sidebar looks unfilled for the whole
 * animation. While the window sits minimized, paint a plain sidebar fill into the page so the snapshot has something
 * to show, and take it back out on restore so the live vibrancy returns.
 */
const MINIMIZED_SIDEBAR_CSS = `
  [data-platform="mac"] nav.side { background: #ececec !important; }
  @media (prefers-color-scheme: dark) { [data-platform="mac"] nav.side { background: #2a2a2d !important; } }
`;

/** Key of the minimized-fill stylesheet currently inserted into the settings page, if any. */
let minimizedCssKey: string | null = null;

function paintMinimizedSidebar(w: BrowserWindow): void {
  void w.webContents.insertCSS(MINIMIZED_SIDEBAR_CSS).then((key) => {
    if (w.isDestroyed()) return;
    // A restore can beat the insert; the fill would then stay over the live vibrancy.
    if (w.isMinimized()) minimizedCssKey = key;
    else void w.webContents.removeInsertedCSS(key).catch(() => undefined);
  });
}

function clearMinimizedSidebar(w: BrowserWindow): void {
  const key = minimizedCssKey;
  minimizedCssKey = null;
  if (key) w.webContents.removeInsertedCSS(key).catch(() => undefined);
}

/** `section`: the id of a settings section to scroll to, e.g. 'room'. */
export function openSettingsWindow(section?: string): BrowserWindow {
  const existing = settingsWindow();
  if (existing) {
    showInDock(true);
    const wasMinimized = existing.isMinimized();
    if (wasMinimized) existing.restore();
    existing.show();
    existing.focus();
    if (IS_MAC) {
      clearMinimizedSidebar(existing);
      if (wasMinimized) reviveVibrancy(existing);
    }
    if (section) existing.webContents.send(SETTINGS_CH.showSection, section);
    return existing;
  }
  const w = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'lolPing',
    icon: nativeImage.createFromPath(assetPath('textures', `${LOGO_TEXTURE}.png`)),
    show: false,
    ...chromeOptions(),
    webPreferences: { preload: preloadPath('settings'), spellcheck: false, backgroundThrottling: !IS_MAC },
  });
  if (!IS_MAC) w.removeMenu(); // no menu bar, so pressing Alt in the window does nothing (macOS keeps the app menu)
  if (IS_MAC) {
    w.on('restore', () => {
      clearMinimizedSidebar(w); // a click on the window in the Dock restores it without the reopen path
      reviveVibrancy(w);
    });
    w.on('minimize', () => paintMinimizedSidebar(w));
  }
  const onTheme = () => {
    if (!w.isDestroyed() && !IS_MAC) {
      if (IS_LINUX) w.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3');
      else w.setTitleBarOverlay(captionColors());
    }
  };
  nativeTheme.on('updated', onTheme);
  w.on('close', () => {
    showInDock(false);
  });
  w.on('closed', () => {
    nativeTheme.off('updated', onTheme);
    win = null;
    showInDock(false);
    notifyGone();
  });
  w.webContents.on('render-process-gone', notifyGone); // the window can stay open on a dead page
  // A link or a file dropped on the window would navigate it to a page of its own, with the settings preload attached. Links
  // are opened with shell.openExternal from the main process (the project link), never by the page.
  w.webContents.on('will-navigate', (event) => {
    if (!isSettingsPage(event.url)) event.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.once('ready-to-show', () => {
    showInDock(true);
    w.show();
  });
  void loadPage(w, 'settings', section);
  win = w;
  return w;
}
