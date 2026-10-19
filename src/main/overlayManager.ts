import { BrowserWindow, ipcMain, screen, type Display, type Rectangle, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { isEmoteRefShape, type EmoteArt, type EmoteRef } from '../shared/emotes';
import {
  OVERLAY_ASSETS, OVERLAY_EMOTED, OVERLAY_PINGED, type OverlayChannel, type OverlayEvents, type PingTag,
} from '../shared/ipc';
import { isPingId, type PingId } from '../shared/pings';
import type { HelperEvent, WheelKind } from '../shared/protocol';
import type { OverlaySettings, RoomTextStyle } from '../shared/settings';
import { physicalToLocal, type DisplayMap } from './coords';
import { numberDisplays, type NumberedDisplay } from './displayNumbers';
import { IS_LINUX, IS_MAC, loadPage, preloadPath } from './paths';

/** A ping the user just placed, in overlay-local CSS px: the room shares these. */
export interface SharedPing {
  id: PingId;
  displayId: number;
  x: number;
  y: number;
}

/** An emote the user just placed, in overlay-local CSS px: the room shares these. */
export interface SharedEmote {
  ref: EmoteRef;
  displayId: number;
  x: number;
  y: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Where a display's overlay window goes. Windows takes a shown window that covers a whole display for a full-screen app:
 * the taskbar drops behind it and an auto-hidden one won't slide up. One DIP short of the bottom edge, it doesn't.
 */
export const overlayBounds = (d: Display): Rectangle =>
  IS_MAC || IS_LINUX ? d.bounds : { ...d.bounds, height: d.bounds.height - 1 };

/** Physical pixels per DIP in a display's map. macOS reports DIPs; Linux is forced to scale 1 at startup. */
const mapScale = (d: Display): number => (IS_MAC || IS_LINUX ? 1 : d.scaleFactor);

/** Messages that put something new on an overlay. */
const RAISING_CHANNELS: ReadonlySet<OverlayChannel> = new Set<OverlayChannel>(['wheel:open', 'ping:spawn', 'emote:spawn', 'toast:show', 'text:spawn']);

/**
 * One transparent, click-through, always-on-top window per display.
 * Emits 'shared' (SharedPing) for every wheel or trigger+click ping and 'sharedEmote' (SharedEmote) for every wheel or
 * trigger+click emote, never for settings previews.
 */
export class OverlayManager extends EventEmitter {
  readonly missingAssets = new Set<string>();
  private readonly windows = new Map<number, BrowserWindow>();
  private maps: DisplayMap[] = [];
  private numberedList: NumberedDisplay[] = [];
  private wheelDisplay: number | null = null;
  private wheelKind: WheelKind = 'ping';

  /** `resolveArt` says what an emote looks like: `remote` is true for a room member's, whose files may be missing here. */
  constructor(private settings: OverlaySettings, private readonly resolveArt: (ref: EmoteRef, remote: boolean, peer?: string) => EmoteArt) {
    super();
  }

  start(): void {
    ipcMain.on(OVERLAY_ASSETS, (_event, missing: unknown) => {
      if (!Array.isArray(missing)) return;
      for (const m of missing) if (typeof m === 'string') this.missingAssets.add(m);
    });
    ipcMain.on(OVERLAY_PINGED, (event, raw: unknown) => {
      const p = raw as { id?: unknown; x?: unknown; y?: unknown } | null;
      if (!p || !isPingId(p.id) || !isNum(p.x) || !isNum(p.y)) return;
      const displayId = this.displayOf(event.sender);
      if (displayId === undefined) return;
      this.emit('shared', { id: p.id, displayId, x: p.x, y: p.y } satisfies SharedPing);
      this.unkeepElsewhere(displayId); // the wheel's own overlay already swapped its kept ping for this one
    });
    ipcMain.on(OVERLAY_EMOTED, (event, raw: unknown) => {
      const p = raw as { ref?: unknown; x?: unknown; y?: unknown } | null;
      if (!p || !isEmoteRefShape(p.ref) || !isNum(p.x) || !isNum(p.y)) return;
      const displayId = this.displayOf(event.sender);
      if (displayId === undefined) return;
      this.emit('sharedEmote', { ref: p.ref, displayId, x: p.x, y: p.y } satisfies SharedEmote);
      // The wheel's own overlay already shows it. Another display may still hold an earlier one of ours.
      this.clearElsewhere(displayId, 'self');
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
    // A wheel or a click is placed from screen coordinates, so stale display info would clip or misplace it.
    if (ev.type === 'wheelOpen' || ev.type === 'click') this.refreshDisplays();
    switch (ev.type) {
      case 'wheelOpen': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (!p) return;
        this.wheelDisplay = p.displayId;
        this.wheelKind = ev.wheel;
        this.send(p.displayId, 'wheel:open', { x: p.x, y: p.y, wheel: ev.wheel });
        break;
      }
      case 'wheelMove':
      case 'wheelRelease': {
        if (this.wheelDisplay === null) return;
        const p = physicalToLocal(ev.x, ev.y, this.maps, this.wheelDisplay);
        if (!p) return;
        this.send(p.displayId, ev.type === 'wheelMove' ? 'wheel:move' : 'wheel:release', { x: p.x, y: p.y, wheel: this.wheelKind });
        if (ev.type === 'wheelRelease') this.wheelDisplay = null;
        break;
      }
      case 'click': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (!p) break;
        if (ev.wheel === 'emote') {
          const ref = this.settings.clickEmoteId;
          this.send(p.displayId, 'emote:spawn', { owner: 'self', art: this.resolveArt(ref, false), x: p.x, y: p.y });
          this.clearElsewhere(p.displayId, 'self');
          this.emit('sharedEmote', { ref, displayId: p.displayId, x: p.x, y: p.y } satisfies SharedEmote);
          break;
        }
        const keep = this.settings.keepLastPing ? { keep: true } : {};
        this.send(p.displayId, 'ping:spawn', { id: this.settings.clickPingId, x: p.x, y: p.y, ...keep });
        this.unkeepElsewhere(p.displayId);
        this.emit('shared', { id: this.settings.clickPingId, displayId: p.displayId, x: p.x, y: p.y } satisfies SharedPing);
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

  /** A room member's ping, already mapped onto one of our displays. */
  spawnRemote(p: { displayId: number; x: number; y: number; id: PingId; tag: PingTag }): void {
    this.send(p.displayId, 'ping:spawn', { id: p.id, x: p.x, y: p.y, tag: p.tag });
  }

  /** Shows an emote in the middle of the main display, without sharing it (the settings page's preview). */
  previewEmote(ref: EmoteRef): void {
    const d = screen.getPrimaryDisplay();
    this.send(d.id, 'emote:spawn', { owner: 'preview', art: this.resolveArt(ref, false), x: d.bounds.width / 2, y: d.bounds.height / 2 });
  }

  /** A room member's emote, already mapped onto one of our displays. It replaces their earlier one, whichever display that was on. */
  spawnRemoteEmote(p: { displayId: number; x: number; y: number; ref: EmoteRef; fx?: number; peer: string; tag: PingTag }): void {
    const art = this.resolveArt(p.ref, true, p.peer);
    // The effect is the sender's choice, so the one on their message wins — over a cached still's plain pop, and over
    // the effect we picked if we happen to have the same image imported.
    const withFx = art.kind === 'custom' ? { ...art, fx: p.fx ?? 0 } : art;
    this.send(p.displayId, 'emote:spawn', { owner: p.peer, art: withFx, x: p.x, y: p.y, tag: p.tag });
    this.clearElsewhere(p.displayId, p.peer);
  }

  /** A line of room text (ours, with no tag, or a member's), already mapped onto one of our displays. */
  spawnText(p: { displayId: number; x: number; y: number; text: string; owner: string; style: RoomTextStyle; tag?: PingTag }): void {
    const { displayId, ...line } = p;
    this.send(displayId, 'text:spawn', line);
  }

  /** This machine's displays with their room numbers (#1 = primary). */
  numbered(): NumberedDisplay[] {
    return this.numberedList;
  }

  toast(title: string, body: string): void {
    this.send(screen.getPrimaryDisplay().id, 'toast:show', { title, body });
  }

  destroy(): void {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
  }

  /** Removes our kept ping, whichever display it is on (lolPing was paused). */
  dropKeptPings(): void {
    if (!this.settings.keepLastPing) return;
    for (const id of this.windows.keys()) this.send(id, 'ping:unkeep', null);
  }

  /** Dismisses a wheel that is on screen, if any. Also used when the helper stops: its cancel would never arrive. */
  cancelWheel(): void {
    if (this.wheelDisplay === null) return;
    this.send(this.wheelDisplay, 'wheel:cancel', null);
    this.wheelDisplay = null;
  }

  private displayOf(sender: WebContents): number | undefined {
    const win = BrowserWindow.fromWebContents(sender);
    return [...this.windows].find(([, w]) => w === win)?.[0];
  }

  /**
   * A game can switch the display mode without Electron noticing (electron/electron#3403), leaving the windows and
   * the coordinate maps sized for the old mode: wheels then clip at the new screen edges, or land on the wrong
   * display. Check before drawing something new, and rebuild everything at once when reality moved on.
   */
  private refreshDisplays(): void {
    if (this.maps.length === 0) return;
    const displays = screen.getAllDisplays();
    const moved = displays.length !== this.maps.length
      || displays.some((d) => {
        const m = this.maps.find((map) => map.id === d.id);
        // Without the scale, 4K at 200% and 1080p at 100% look the same: both are 1920x1080 DIPs.
        return !m || m.dip.x !== d.bounds.x || m.dip.y !== d.bounds.y
          || m.dip.width !== d.bounds.width || m.dip.height !== d.bounds.height || m.scale !== mapScale(d);
      });
    if (moved) this.rebuild();
  }

  /** We keep one ping on screen: drop it on every display but the one that just showed our new one. */
  private unkeepElsewhere(displayId: number): void {
    if (!this.settings.keepLastPing) return;
    for (const id of this.windows.keys()) if (id !== displayId) this.send(id, 'ping:unkeep', null);
  }

  /** Each owner has one emote on screen: clear theirs on every display but the one that just showed their new one. */
  private clearElsewhere(displayId: number, owner: string): void {
    for (const id of this.windows.keys()) if (id !== displayId) this.send(id, 'emote:clear', { owner });
  }

  private rebuild(): void {
    this.cancelWheel();
    const displays = screen.getAllDisplays();
    // dipToScreenRect exists only on Windows.
    this.maps = displays.map((d) => IS_MAC || IS_LINUX
      ? { id: d.id, dip: d.bounds, phys: d.bounds, scale: mapScale(d) }
      : { id: d.id, dip: d.bounds, phys: screen.dipToScreenRect(null, d.bounds), scale: mapScale(d) });
    this.numberedList = numberDisplays(displays, screen.getPrimaryDisplay().id);
    this.emit('displays', this.numberedList);
    for (const [id, win] of this.windows) {
      if (!displays.some((d) => d.id === id)) {
        win.destroy();
        this.windows.delete(id);
      }
    }
    for (const d of displays) {
      const win = this.windows.get(d.id);
      if (win) win.setBounds(overlayBounds(d));
      else this.windows.set(d.id, this.createWindow(d));
    }
  }

  private createWindow(d: Display): BrowserWindow {
    const win = new BrowserWindow({
      ...overlayBounds(d),
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
      enableLargerThanScreen: true, // also stops macOS pushing the window below the menu bar
      show: false,
      type: IS_MAC ? 'panel' : 'toolbar', // a macOS panel can float over full-screen apps
      webPreferences: {
        preload: preloadPath('overlay'),
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_LINUX) win.setVisibleOnAllWorkspaces(true);
    if (IS_MAC) {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.setHiddenInMissionControl(true); // the overlay isn't a window to the user: keep it out of Mission Control
    }
    win.webContents.on('did-finish-load', () => win.webContents.send('overlay:settings', this.settings));
    win.once('ready-to-show', () => {
      win.showInactive();
      win.setBounds(overlayBounds(d)); // re-apply: mixed-DPI setups can size the first frame wrong
    });
    void loadPage(win, 'overlay');
    return win;
  }

  private send<C extends OverlayChannel>(displayId: number, channel: C, payload: OverlayEvents[C]): void {
    // A room ping, a toast or a preview can appear with no gesture ahead of it, so the check lives here too.
    if (RAISING_CHANNELS.has(channel)) this.refreshDisplays();
    const w = this.windows.get(displayId);
    if (!w || w.isDestroyed()) return;
    // Windows 10 can drop the overlay behind normal windows after a while (#70), and only a restart brought it back.
    // Setting the level again puts it back on top of the topmost windows. Only when something new appears, not per move.
    if (!IS_MAC && !IS_LINUX && RAISING_CHANNELS.has(channel)) w.setAlwaysOnTop(true, 'screen-saver');
    w.webContents.send(channel, payload);
  }
}
