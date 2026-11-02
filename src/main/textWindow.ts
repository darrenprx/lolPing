import { BrowserWindow, ipcMain, screen } from 'electron';
import { TEXT_CH, type Point, type TextAnswer, type TextBoxText } from '../shared/ipc';
import { placeInside } from './coords';
import { IS_MAC, loadPage, pageUrl, preloadPath } from './paths';

/** The box's size in DIPs. */
const WIDTH = 420;
const HEIGHT = 64;
/** If the box has no keyboard focus by then (another app held it, or the page never loaded), it closes instead of sitting there. */
const FOCUS_WAIT_MS = 2000;

let win: BrowserWindow | null = null;
let at: Point = { x: 0, y: 0 };
let text: TextBoxText | null = null;
let submit: ((raw: string, at: Point) => TextAnswer) | null = null;
const goneListeners: Array<() => void> = [];

export function onTextWindowGone(cb: () => void): void {
  goneListeners.push(cb);
}

export function textWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** Closes the box if it is open, for when the room it was opened for is gone. */
export function closeTextWindow(): void {
  if (win && !win.isDestroyed()) win.close();
}

/** `onSubmit` answers what the box typed: 'sent' closes it, anything else keeps it open with that hint. */
export function registerTextWindow(onSubmit: (raw: string, at: Point) => TextAnswer): void {
  submit = onSubmit;
  ipcMain.handle(TEXT_CH.submit, (event, raw: unknown): TextAnswer => {
    if (win?.webContents !== event.sender || typeof raw !== 'string' || !submit) return 'unknown';
    const answer = submit(raw, at);
    if (answer === 'sent') win.close();
    return answer;
  });
  ipcMain.on(TEXT_CH.cancel, (event) => {
    if (win?.webContents === event.sender) win.close();
  });
  ipcMain.handle(TEXT_CH.strings, (event): TextBoxText | null => (win?.webContents === event.sender ? text : null));
}

/** Opens the text box with its top-left corner at `point` (a screen point in DIPs), inside that display's work area. */
export function openTextWindow(point: Point, strings: TextBoxText): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  at = point;
  text = strings;
  const spot = placeInside(point, { width: WIDTH, height: HEIGHT }, screen.getDisplayNearestPoint(point).workArea);
  const w = new BrowserWindow({
    ...spot,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // macOS: a non-activating panel takes key focus without making lolPing the active app, so the app the box was opened over stays active.
    ...(IS_MAC ? { type: 'panel' as const } : {}),
    webPreferences: { preload: preloadPath('text'), spellcheck: false },
  });
  win = w;
  // Every way the box can end goes through close(), whose 'closed' event releases the caller's suspend.
  try {
    setup(w);
  } catch (err) {
    w.destroy();
    throw err;
  }
}

function setup(w: BrowserWindow): void {
  w.on('closed', () => {
    if (win === w) win = null;
    for (const cb of goneListeners) cb();
  });
  // Keep macOS IME candidate pop-ups above the text box.
  w.setAlwaysOnTop(true, IS_MAC ? 'status' : 'screen-saver');
  let focused = false;
  w.on('focus', () => {
    focused = true;
  });
  // Clicking away cancels. Not before the box has had focus once, or showing it would close it.
  w.on('blur', () => {
    if (focused) w.close();
  });
  setTimeout(() => {
    if (!w.isDestroyed() && !focused) w.close();
  }, FOCUS_WAIT_MS);
  w.once('ready-to-show', () => {
    w.show();
    w.focus();
  });
  const closeIfAlive = (): void => {
    if (!w.isDestroyed()) w.close();
  };
  w.webContents.on('did-fail-load', closeIfAlive);
  w.webContents.on('render-process-gone', closeIfAlive);
  const ownUrl = new URL(pageUrl('text'));
  w.webContents.on('will-navigate', (event) => {
    try {
      const target = new URL(event.url);
      if (target.protocol !== ownUrl.protocol || target.host !== ownUrl.host || target.pathname !== ownUrl.pathname) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loadPage(w, 'text').catch(closeIfAlive);
}
