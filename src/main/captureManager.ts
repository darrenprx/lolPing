import { BrowserWindow, desktopCapturer, ipcMain, screen, type Display } from 'electron';
import { EventEmitter } from 'node:events';
import { CAPTURE_CANCEL, CAPTURE_CONFIRM, type CaptureRect } from '../shared/ipc';
import { IS_MAC, loadPage, preloadPath } from './paths';

export interface CapturedShot {
  displayId: number;
  /** The confirmed area's pixels, JPEG-encoded. */
  jpeg: Buffer;
}

export interface CaptureManagerDeps {
  /** The helper is suspended while the capture takes the mouse, so its gestures can't fight the selection. */
  setSuspended(on: boolean): void;
  /** The one-line instruction and the toolbar labels, in the app language. */
  texts(): { hint: string; confirm: string; cancel: string };
}

/**
 * WeChat-style screen capture: one dark fullscreen window per display that takes the mouse; a drag marks an area, a
 * click marks the whole display, Enter confirms, Esc cancels. Emits 'captured' (CapturedShot) once, then closes.
 * Both endings resume the helper again.
 */
export class CaptureManager extends EventEmitter {
  private readonly windows = new Map<number, BrowserWindow>();
  private active = false;
  /** The capture takes the mouse and suspends the helper, so it ends itself when the user walks away. */
  private static readonly TIMEOUT_MS = 60_000;
  private timeout: NodeJS.Timeout | null = null;

  constructor(private readonly d: CaptureManagerDeps) {
    super();
    ipcMain.on(CAPTURE_CONFIRM, (event, raw: unknown) => {
      const displayId = this.displayOf(event.sender);
      if (displayId === undefined || !this.active) return;
      const rect = this.confirmedRect(raw);
      if (!rect) {
        console.warn('[capture] confirmed rect was invalid');
        return;
      }
      void this.finish(displayId, rect);
    });
    ipcMain.on(CAPTURE_CANCEL, (event) => {
      if (!this.active) return;
      const displayId = this.displayOf(event.sender);
      if (displayId !== undefined) this.cancel();
    });
    screen.on('display-added', () => this.syncDisplays());
    screen.on('display-removed', () => this.syncDisplays());
  }

  /** Whether a capture is on screen right now. */
  isActive(): boolean {
    return this.active;
  }

  start(originDisplayId: number): void {
    if (this.active) return;
    this.active = true;
    this.timeout = setTimeout(() => this.cancel(), CaptureManager.TIMEOUT_MS);
    this.d.setSuspended(true);
    this.syncDisplays();
    // The origin display takes focus so Esc works at once; the others darken without stealing anything.
    for (const [id, win] of this.windows) {
      if (id === originDisplayId) win.show();
      else win.showInactive();
    }
  }

  close(): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy();
    this.windows.clear();
    if (this.active) {
      this.active = false;
      this.d.setSuspended(false);
    }
  }

  private cancel(): void {
    this.close();
    this.emit('cancelled');
  }

  private async finish(displayId: number, rect: CaptureRect): Promise<void> {
    let jpeg: Buffer | null = null;
    try {
      jpeg = await this.shot(displayId, rect);
    } catch (e) {
      console.warn('[capture] screen shot failed:', e instanceof Error ? e.message : e);
    }
    this.close();
    if (jpeg) {
      console.log(`[capture] shot ${jpeg.length} bytes from display ${displayId}`);
      this.emit('captured', { displayId, jpeg } satisfies CapturedShot);
    } else {
      this.emit('cancelled');
    }
  }

  /** One transparent window per display, the same shape the ping overlays use, but taking the mouse. */
  private syncDisplays(): void {
    if (!this.active) return;
    const displays = screen.getAllDisplays();
    for (const [id, win] of this.windows) {
      if (!displays.some((d) => d.id === id)) {
        win.destroy();
        this.windows.delete(id);
      }
    }
    for (const d of displays) {
      const win = this.windows.get(d.id);
      if (win && !win.isDestroyed()) win.setBounds(d.bounds);
      else this.windows.set(d.id, this.createWindow(d));
    }
  }

  private createWindow(d: Display): BrowserWindow {
    const win = new BrowserWindow({
      ...d.bounds,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      show: false,
      type: IS_MAC ? 'panel' : 'toolbar',
      webPreferences: { preload: preloadPath('capture'), backgroundThrottling: false, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // The begin message carries the texts; one sent before the page loads would be lost.
    win.webContents.on('did-finish-load', () => {
      if (this.windows.get(d.id) === win && this.active) win.webContents.send('capture:begin', this.d.texts());
    });
    win.once('ready-to-show', () => {
      if (this.windows.get(d.id) === win && !win.isVisible()) win.showInactive();
      win.setBounds(d.bounds); // re-apply: mixed-DPI setups can size the first frame wrong
    });
    win.on('closed', () => {
      this.windows.delete(d.id);
      if (this.active && this.windows.size === 0) this.cancel();
    });
    void loadPage(win, 'capture');
    return win;
  }

  /** The confirmed area, clamped to the display and rejected when there is nothing to shoot. */
  private confirmedRect(raw: unknown): CaptureRect | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Partial<CaptureRect>;
    const nums = [r.x, r.y, r.width, r.height];
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
    const x = Math.max(0, Math.round(r.x as number));
    const y = Math.max(0, Math.round(r.y as number));
    const width = Math.max(1, Math.round(r.width as number));
    const height = Math.max(1, Math.round(r.height as number));
    if (width < 2 || height < 2) return null;
    return { x, y, width, height };
  }

  /** The display's pixels under `rect` (CSS px local to it), JPEG-encoded. Null when the screen can't be read. */
  private async shot(displayId: number, rect: CaptureRect): Promise<Buffer | null> {
    const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.bounds.width, height: display.bounds.height },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source) return null;
    // The thumbnail comes back at its own scale, so measure it rather than trust the display's DPI.
    const size = source.thumbnail.getSize();
    if (size.width <= 0 || size.height <= 0) return null;
    const scale = size.width / display.bounds.width;
    const crop = {
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.min(Math.round(rect.width * scale), size.width),
      height: Math.min(Math.round(rect.height * scale), size.height),
    };
    return source.thumbnail.crop(crop).toJPEG(90);
  }

  /** Which capture window a message came from, in display ids. */
  private displayOf(sender: Electron.WebContents): number | undefined {
    const win = BrowserWindow.fromWebContents(sender);
    return [...this.windows].find(([, w]) => w === win)?.[0];
  }
}
