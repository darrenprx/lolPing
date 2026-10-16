import { BrowserWindow, ipcMain, screen, type Display } from 'electron';
import { OVERLAY_ASSETS, type OverlayChannel, type OverlayEvents } from '../shared/ipc';
import type { PingId } from '../shared/pings';
import type { HelperEvent } from '../shared/protocol';
import type { OverlaySettings } from '../shared/settings';
import { physicalToLocal, type DisplayMap } from './coords';
import { loadPage, preloadPath } from './paths';

/** One transparent, click-through, always-on-top window per display. */
export class OverlayManager {
  readonly missingAssets = new Set<string>();
  private readonly windows = new Map<number, BrowserWindow>();
  private maps: DisplayMap[] = [];
  private wheelDisplay: number | null = null;

  constructor(private settings: OverlaySettings) {}

  start(): void {
    ipcMain.on(OVERLAY_ASSETS, (_event, missing: unknown) => {
      if (!Array.isArray(missing)) return;
      for (const m of missing) if (typeof m === 'string') this.missingAssets.add(m);
    });
    this.rebuild();
    screen.on('display-added', () => this.rebuild());
    screen.on('display-removed', () => this.rebuild());
    screen.on('display-metrics-changed', () => this.rebuild());
  }

  updateSettings(s: OverlaySettings): void {
    this.settings = s;
    for (const id of this.windows.keys()) this.send(id, 'overlay:settings', s);
  }

  handle(ev: HelperEvent): void {
    switch (ev.type) {
      case 'wheelOpen': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (!p) return;
        this.wheelDisplay = p.displayId;
        this.send(p.displayId, 'wheel:open', { x: p.x, y: p.y });
        break;
      }
      case 'wheelMove':
      case 'wheelRelease': {
        if (this.wheelDisplay === null) return;
        const p = physicalToLocal(ev.x, ev.y, this.maps, this.wheelDisplay);
        if (!p) return;
        this.send(p.displayId, ev.type === 'wheelMove' ? 'wheel:move' : 'wheel:release', { x: p.x, y: p.y });
        if (ev.type === 'wheelRelease') this.wheelDisplay = null;
        break;
      }
      case 'click': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (p) this.send(p.displayId, 'ping:spawn', { id: this.settings.clickPingId, x: p.x, y: p.y });
        break;
      }
      case 'cancel':
        this.cancelWheel();
        break;
      default:
        break;
    }
  }

  previewPing(id: PingId): void {
    const d = screen.getPrimaryDisplay();
    this.send(d.id, 'ping:spawn', { id, x: d.bounds.width / 2, y: d.bounds.height / 2 });
  }

  toast(title: string, body: string): void {
    this.send(screen.getPrimaryDisplay().id, 'toast:show', { title, body });
  }

  destroy(): void {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
  }

  /** Dismisses a wheel that is on screen, if any. Also used when the helper stops: its cancel would never arrive. */
  cancelWheel(): void {
    if (this.wheelDisplay === null) return;
    this.send(this.wheelDisplay, 'wheel:cancel', null);
    this.wheelDisplay = null;
  }

  private rebuild(): void {
    this.cancelWheel();
    const displays = screen.getAllDisplays();
    this.maps = displays.map((d) => ({ id: d.id, dip: d.bounds, phys: screen.dipToScreenRect(null, d.bounds), scale: d.scaleFactor }));
    for (const [id, win] of this.windows) {
      if (!displays.some((d) => d.id === id)) {
        win.destroy();
        this.windows.delete(id);
      }
    }
    for (const d of displays) {
      const win = this.windows.get(d.id);
      if (win) win.setBounds(d.bounds);
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
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      show: false,
      type: 'toolbar',
      webPreferences: {
        preload: preloadPath('overlay'),
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.on('did-finish-load', () => win.webContents.send('overlay:settings', this.settings));
    win.once('ready-to-show', () => {
      win.showInactive();
      win.setBounds(d.bounds); // re-apply: mixed-DPI setups can size the first frame wrong
    });
    void loadPage(win, 'overlay');
    return win;
  }

  private send<C extends OverlayChannel>(displayId: number, channel: C, payload: OverlayEvents[C]): void {
    const w = this.windows.get(displayId);
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
