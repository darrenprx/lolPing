import { BrowserWindow, globalShortcut, ipcMain, screen, type IpcMainEvent } from 'electron';
import { CHAT_CH, type Point, type RoomChatState, type TextAnswer } from '../shared/ipc';
import { ROOM_CHAT_ACCELERATOR } from '../shared/roomChat';
import { MAX_TEXT } from '../shared/roomProtocol';
import { placeInside, type Rect } from './coords';
import { IS_LINUX, IS_MAC, loadPage, pageUrl, preloadPath } from './paths';

/** Starts near the bottom-left, but fits even a small display's work area. */
export function roomChatPlacement(area: Rect, previous?: Rect): Rect {
  const size = { width: Math.min(previous?.width ?? 620, area.width), height: Math.min(previous?.height ?? 340, area.height) };
  const at = previous ?? { x: area.x + 24, y: area.y + area.height - size.height - 24 };
  return { ...placeInside(at, size, area), ...size };
}

interface RoomChatDeps {
  state(): RoomChatState;
  submit(raw: string, at: Point): TextAnswer;
  /** Focus, not visibility, suspends the helper so Ctrl-drag and custom trigger keys work while typing. */
  focused(on: boolean): void;
  shortcutFailed(): void;
}

/** A focusable desktop chat; only its own page can read history, keep a draft, send a line or hide it. */
export class RoomChatWindow {
  private win: BrowserWindow | null = null;
  private shown = false;
  private live = false;
  private registered = false;
  private attempted = false;
  private focused = false;
  private at: Point = { x: 0, y: 0 };
  private bounds: Rect | undefined;
  private draft = '';

  constructor(private readonly deps: RoomChatDeps) {
    ipcMain.handle(CHAT_CH.get, (event): RoomChatState | null =>
      this.win?.webContents === event.sender && this.live && this.shown ? { ...this.deps.state(), draft: this.draft } : null);
    ipcMain.handle(CHAT_CH.submit, (event, raw: unknown): TextAnswer => {
      if (this.win?.webContents !== event.sender || !this.live || !this.shown || typeof raw !== 'string') return 'unknown';
      return this.deps.submit(raw, this.at);
    });
    ipcMain.on(CHAT_CH.hide, this.onHide);
    ipcMain.on(CHAT_CH.draft, this.onDraft);
  }

  /** A room leave discards unsent text too, even when the user later rejoins the same code. */
  clearDraft(): void {
    this.draft = '';
  }

  /** No registered shortcut outside a live room, while paused, or while settings captures a key. */
  sync(live: boolean, shortcut: boolean): void {
    this.live = live;
    if (!live) this.hide();
    const want = live && shortcut;
    if (!want) {
      if (this.registered) globalShortcut.unregister(ROOM_CHAT_ACCELERATOR);
      this.registered = false;
      this.attempted = false;
      return;
    }
    if (this.attempted) return;
    this.attempted = true;
    try {
      this.registered = globalShortcut.register(ROOM_CHAT_ACCELERATOR, () => this.toggle());
    } catch {
      this.registered = false;
    }
    if (!this.registered) this.deps.shortcutFailed();
  }

  toggle(): void {
    if (!this.live) return;
    if (this.shown) return this.hide();
    this.at = screen.getCursorScreenPoint();
    const area = this.bounds ? screen.getDisplayMatching(this.bounds).workArea : screen.getDisplayNearestPoint(this.at).workArea;
    const bounds = roomChatPlacement(area, this.bounds);
    this.shown = true;
    const w = this.win && !this.win.isDestroyed() ? this.win : this.create(bounds);
    w.setBounds(bounds);
    if (w.webContents.isLoadingMainFrame()) return;
    this.reveal(w);
  }

  hide(): void {
    this.shown = false;
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) {
      this.bounds = w.getBounds();
      // On Windows, a hidden focused window can keep the foreground: closing returns input to the app underneath.
      w.close();
    }
    this.setFocused(false);
  }

  update(): void {
    if (this.shown && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(CHAT_CH.state, { ...this.deps.state(), draft: this.draft });
    }
  }

  destroy(): void {
    this.sync(false, false);
    ipcMain.removeHandler(CHAT_CH.get);
    ipcMain.removeHandler(CHAT_CH.submit);
    ipcMain.removeListener(CHAT_CH.hide, this.onHide);
    ipcMain.removeListener(CHAT_CH.draft, this.onDraft);
  }

  private readonly onHide = (event: IpcMainEvent): void => {
    if (this.win?.webContents === event.sender) this.hide();
  };

  private readonly onDraft = (event: IpcMainEvent, raw: unknown): void => {
    if (this.win?.webContents !== event.sender || !this.live || !this.shown || typeof raw !== 'string') return;
    this.draft = [...raw].slice(0, MAX_TEXT).join('');
  };

  private setFocused(on: boolean): void {
    if (on === this.focused) return;
    this.focused = on;
    this.deps.focused(on);
  }

  private reveal(w: BrowserWindow): void {
    w.webContents.send(CHAT_CH.state, { ...this.deps.state(), draft: this.draft });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.show();
    w.focus();
  }

  private create(bounds: Rect): BrowserWindow {
    const w = new BrowserWindow({
      ...bounds,
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
      ...(IS_MAC ? { type: 'panel' as const } : {}),
      webPreferences: { preload: preloadPath('chat'), spellcheck: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.win = w;
    w.setAlwaysOnTop(true, 'screen-saver');
    if (IS_LINUX) w.setVisibleOnAllWorkspaces(true);
    if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.on('focus', () => { if (this.win === w) this.setFocused(true); });
    w.on('blur', () => { if (this.win === w) this.setFocused(false); });
    w.on('closed', () => {
      if (this.win !== w) return;
      this.win = null;
      this.shown = false;
      this.setFocused(false);
    });
    w.webContents.on('did-finish-load', () => {
      if (this.win === w && this.live && this.shown) this.reveal(w);
    });
    const drop = (): void => {
      if (!w.isDestroyed()) w.destroy();
    };
    w.webContents.on('did-fail-load', drop);
    w.webContents.on('render-process-gone', drop);
    const own = new URL(pageUrl('chat'));
    w.webContents.on('will-navigate', (event) => {
      try {
        const target = new URL(event.url);
        if (target.protocol !== own.protocol || target.host !== own.host || target.pathname !== own.pathname) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loadPage(w, 'chat').catch(drop);
    return w;
  }
}
