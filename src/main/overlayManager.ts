import { BrowserWindow, ipcMain, screen, type Display, type Rectangle, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { isEmoteRefShape, type EmoteArt, type EmoteRef } from '../shared/emotes';
import {
  OVERLAY_ASSETS, OVERLAY_EMOTED, OVERLAY_IDLE, OVERLAY_PINGED, type OverlayChannel, type OverlayEvents, type PingTag,
} from '../shared/ipc';
import { WHEEL, pickSlice } from '../shared/geometry';
import { isPingId, type PingId } from '../shared/pings';
import type { HelperEvent, WheelKind } from '../shared/protocol';
import type { OverlaySettings, RoomTextStyle } from '../shared/settings';
import type { Rect } from '../shared/teammate/coords';
import {
  displayAtPhysical, physicalBoxToLocal, physicalToDip, physicalToLocal, type DisplayMap, type LocalPoint,
} from './coords';
import { numberDisplays, type NumberedDisplay } from './displayNumbers';
import { HIDDEN_TEST_RUN, IS_LINUX, IS_MAC, loadPage, preloadPath } from './paths';

/** A ping the user just placed, in overlay-local CSS px: the room shares these. */
export interface SharedPing {
  batch?: string;
  id: PingId;
  displayId: number;
  x: number;
  y: number;
}

/** An emote the user just placed, in overlay-local CSS px: the room shares these. */
export interface SharedEmote {
  batch?: string;
  ref: EmoteRef;
  displayId: number;
  x: number;
  y: number;
}

/** An ask-wheel release on a slice whose intent is on: the wheel centre, in overlay CSS px and physical px. */
export interface AskRelease {
  displayId: number;
  x: number;
  y: number;
  phys: { x: number; y: number };
  id: PingId;
}

/** Ask key + click (no drag), in overlay CSS px and physical px. */
export interface AskClick {
  displayId: number;
  x: number;
  y: number;
  phys: { x: number; y: number };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Where a display's overlay window goes. Windows takes a shown window that covers a whole display for a full-screen app:
 * the taskbar drops behind it and an auto-hidden one won't slide up. One DIP short of the bottom edge, it doesn't.
 */
export const overlayBounds = (d: Display): Rectangle =>
  IS_MAC || IS_LINUX ? d.bounds : { ...d.bounds, height: d.bounds.height - 1 };

const overlaps = (a: Rectangle, b: Rectangle): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where an empty overlay waits on Windows (#127): still shown, moved off its display but for one DIP along a side no
 * other display borders. Screenshot tools then find the windows under the pointer. Hiding it instead made Windows play
 * its show animation each time, so the wheel slid in from the display's centre. The DIP left on the display keeps the
 * window at that display's scale. Null when every side borders another display.
 */
export function parkedBounds(display: Rectangle, overlay: Rectangle, others: readonly Rectangle[]): Rectangle | null {
  const { x, y, width, height } = overlay;
  const sides = [
    { x, y: display.y - height + 1, width, height },
    { x, y: display.y + display.height - 1, width, height },
    { x: display.x - width + 1, y, width, height },
    { x: display.x + display.width - 1, y, width, height },
  ];
  return sides.find((r) => !others.some((o) => overlaps(r, o))) ?? null;
}

/** Physical pixels per DIP in a display's map. macOS reports DIPs; Linux is forced to scale 1 at startup. */
const mapScale = (d: Display): number => (IS_MAC || IS_LINUX ? 1 : d.scaleFactor);

/** Messages that put something new on an overlay. */
const RAISING_CHANNELS: ReadonlySet<OverlayChannel> = new Set<OverlayChannel>([
  'wheel:open', 'ping:spawn', 'emote:spawn', 'toast:show', 'marker:blocked', 'text:spawn', 'mate:glow',
]);

/** The owner of the teammate's pings and emotes on every overlay. */
const MATE = 'mate';
/** Spec §10: the fields of one fill light up in order, this far apart. */
const GLOW_STEP_MS = 120;

/**
 * One transparent, click-through, always-on-top window per display.
 * Emits 'shared' (SharedPing) for every wheel or trigger+click ping and 'sharedEmote' (SharedEmote) for every wheel or
 * trigger+click emote, never for settings previews. Ask-wheel gestures are never shared: a release on an enabled slice
 * emits 'askRelease' (AskRelease) and an ask click 'askClick' (AskClick).
 */
export class OverlayManager extends EventEmitter {
  readonly missingAssets = new Set<string>();
  private readonly windows = new Map<number, BrowserWindow>();
  private maps: DisplayMap[] = [];
  private numberedList: NumberedDisplay[] = [];
  private wheelDisplay: number | null = null;
  private wheelKind: WheelKind = 'ping';
  /** Where the open wheel was opened, in its overlay and in physical px: an ask release reports the centre. */
  private wheelAt: { local: LocalPoint; phys: { x: number; y: number } } | null = null;
  private mateTicket: string | null = null;
  private captureExcluded = false;
  /** Overlays whose page last said it has nothing on it, parked off their displays (Windows only). */
  private readonly idleWindows = new WeakSet<BrowserWindow>();
  private admitMarker: (p: LocalPoint) => { allowed: boolean; silent?: boolean; batch?: string } = () => ({ allowed: true });

  /** Runs before a completed user marker is drawn or sent. Previews and AI marks never enter this gate. */
  setMarkerAdmission(fn: typeof this.admitMarker): void { this.admitMarker = fn; }

  /** `resolveArt` says what an emote looks like: `remote` is true for a room member's, whose files may be missing here. */
  constructor(private settings: OverlaySettings, private readonly resolveArt: (ref: EmoteRef, remote: boolean) => EmoteArt) {
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
      const admission = this.admitMarker({ displayId, x: p.x, y: p.y });
      if (!admission.allowed) return;
      this.emit('shared', { id: p.id, displayId, x: p.x, y: p.y, ...(admission.batch ? { batch: admission.batch } : {}) } satisfies SharedPing);
      this.unkeepElsewhere(displayId); // the wheel's own overlay already swapped its kept ping for this one
    });
    ipcMain.on(OVERLAY_EMOTED, (event, raw: unknown) => {
      const p = raw as { ref?: unknown; x?: unknown; y?: unknown } | null;
      if (!p || !isEmoteRefShape(p.ref) || !isNum(p.x) || !isNum(p.y)) return;
      const displayId = this.displayOf(event.sender);
      if (displayId === undefined) return;
      const admission = this.admitMarker({ displayId, x: p.x, y: p.y });
      if (!admission.allowed) return;
      this.emit('sharedEmote', { ref: p.ref, displayId, x: p.x, y: p.y, ...(admission.batch ? { batch: admission.batch } : {}) } satisfies SharedEmote);
      // The wheel's own overlay already shows it. Another display may still hold an earlier one of ours.
      this.clearElsewhere(displayId, 'self');
    });
    ipcMain.on(OVERLAY_IDLE, (event, idle: unknown) => {
      // Screenshot tools on Windows take a shown overlay for a window over the whole display (#127): park an empty one.
      if (IS_MAC || IS_LINUX || typeof idle !== 'boolean') return;
      const displayId = this.displayOf(event.sender);
      const win = displayId === undefined ? undefined : this.windows.get(displayId);
      const d = screen.getAllDisplays().find((x) => x.id === displayId);
      if (!win || win.isDestroyed() || !d) return;
      if (idle) this.idleWindows.add(win);
      else this.idleWindows.delete(win);
      if (!idle && !win.isVisible()) win.showInactive(); // it had no free side to park on
      this.place(win, d);
      if (!idle) win.setAlwaysOnTop(true, 'screen-saver');
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

  /**
   * Keeps the overlays out of screen captures (WDA_EXCLUDEFROMCAPTURE) while the teammate grabs the screen, so its
   * image shows no lolPing pings or wheels. Windows only: the macOS capture leaves lolPing's windows out by itself.
   */
  setCaptureExcluded(on: boolean): void {
    if (IS_MAC || IS_LINUX) return;
    this.captureExcluded = on;
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.setContentProtection(on);
  }

  handle(ev: HelperEvent): void {
    // A wheel or a click is placed from screen coordinates, so stale display info would clip or misplace it.
    if (ev.type === 'wheelOpen' || ev.type === 'click' || ev.type === 'askWords') this.refreshDisplays();
    switch (ev.type) {
      case 'wheelOpen': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (!p) return;
        this.wheelDisplay = p.displayId;
        // With the ask key on the ping key, the ping wheel is the ask wheel.
        this.wheelKind = ev.wheel === 'ping' && this.settings.ask.onPing ? 'ask' : ev.wheel;
        this.wheelAt = { local: p, phys: { x: ev.x, y: ev.y } };
        this.send(p.displayId, 'wheel:open', { x: p.x, y: p.y, wheel: this.wheelKind });
        break;
      }
      case 'wheelMove':
      case 'wheelRelease': {
        if (this.wheelDisplay === null) return;
        const p = physicalToLocal(ev.x, ev.y, this.maps, this.wheelDisplay);
        if (!p) return;
        this.send(p.displayId, ev.type === 'wheelMove' ? 'wheel:move' : 'wheel:release', {
          x: p.x, y: p.y, wheel: this.wheelKind,
          ...(ev.type === 'wheelRelease' && this.wheelKind !== 'ask' ? { managed: true } : {}),
        });
        if (ev.type === 'wheelRelease') {
          if (this.wheelKind === 'ask') this.askReleased(p);
          else {
            const open = this.wheelAt?.local;
            if (open) {
              const slice = pickSlice(p.x - open.x, p.y - open.y, (WHEEL.innerR * this.settings.wheelSizePx) / WHEEL.size);
              if (slice >= 0 && this.wheelKind === 'emote') {
                const ref = this.settings.emoteWheel[slice];
                if (ref) this.placeOwnEmote(ref, open);
              } else if (slice >= 0) {
                const id = this.settings.wheel[slice];
                if (id) this.placeOwnPing(id, open);
              }
            }
          }
          this.wheelDisplay = null;
          this.wheelAt = null;
        }
        break;
      }
      case 'click': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (!p) break;
        const ask = ev.wheel === 'ask' || (ev.wheel === 'ping' && this.settings.ask.onPing && this.settings.ask.click);
        if (ask) {
          this.emit('askClick', { displayId: p.displayId, x: p.x, y: p.y, phys: { x: ev.x, y: ev.y } } satisfies AskClick);
          break;
        }
        if (ev.wheel === 'emote') {
          this.placeOwnEmote(this.settings.clickEmoteId, p);
          break;
        }
        this.placeOwnPing(this.settings.clickPingId, p);
        break;
      }
      case 'askWords': {
        // A double tap of the ask key is an ask click that has no button to press.
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (p) this.emit('askClick', { displayId: p.displayId, x: p.x, y: p.y, phys: { x: ev.x, y: ev.y } } satisfies AskClick);
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
  spawnRemote(p: { displayId: number; x: number; y: number; id: PingId; tag: PingTag; silent?: boolean }): void {
    this.send(p.displayId, 'ping:spawn', { id: p.id, x: p.x, y: p.y, tag: p.tag, ...(p.silent ? { silent: true } : {}) });
  }

  /** The ask now running. The teammate's marks sent after this carry it, so an overlay drops any from an older ask. */
  setMateTicket(id: string): void {
    this.mateTicket = id;
    for (const displayId of this.windows.keys()) this.send(displayId, 'mate:ticket', { id });
  }

  /**
   * One of the teammate's pings, already mapped onto one of our displays. Never shared with a room.
   * `keep`: stays until clearMate or fadeMate (the receipt). It never touches the user's own kept ping.
   */
  spawnMate(p: {
    displayId: number; x: number; y: number; id: PingId; label?: string; thinking?: boolean;
    silent?: boolean; keep?: boolean; tagOnly?: boolean; tag: PingTag;
  }): void {
    const { displayId, ...ping } = p;
    const ticket = this.mateTicket === null ? {} : { ticket: this.mateTicket };
    this.send(displayId, 'ping:spawn', { ...ping, owner: MATE, ...ticket });
  }

  /** The teammate's emote (a bundled slug), replacing its earlier one on any display. `keep`: as in spawnMate. */
  spawnMateEmote(p: { displayId: number; x: number; y: number; slug: string; keep?: boolean; tag: PingTag }): void {
    const ticket = this.mateTicket === null ? {} : { ticket: this.mateTicket };
    const keep = p.keep ? { keep: true } : {};
    this.send(p.displayId, 'emote:spawn', {
      owner: MATE, art: { kind: 'bundled', slug: p.slug }, x: p.x, y: p.y, tag: p.tag, ...keep, ...ticket,
    });
    this.clearElsewhere(p.displayId, MATE);
  }

  /** Removes the teammate's pings and emotes on every display at once. */
  clearMate(): void {
    for (const id of this.windows.keys()) this.send(id, 'mate:clear', null);
  }

  /** Fades the teammate's pings and emotes out on every display. */
  fadeMate(): void {
    for (const id of this.windows.keys()) this.send(id, 'mate:fade', null);
  }

  /** The teammate said its first line: the thinking dots on its tags stop. */
  mateSaid(): void {
    for (const id of this.windows.keys()) this.send(id, 'mate:said', null);
  }

  /** Outlines the fields the teammate just wrote (boxes in physical px) in its tag's colour, one after another. */
  glow(boxes: readonly Rect[], tag: PingTag): void {
    // The boxes are mapped before anything is sent, so the maps must be current first.
    this.refreshDisplays();
    const ticket = this.mateTicket === null ? {} : { ticket: this.mateTicket };
    boxes.forEach((box, i) => {
      const at = physicalBoxToLocal(box, this.maps);
      if (!at) return;
      this.send(at.displayId, 'mate:glow', {
        box: { x: at.x, y: at.y, w: at.w, h: at.h }, color: tag.color, rgb: tag.rgb ?? null, delay: i * GLOW_STEP_MS,
        ...ticket,
      });
    });
  }

  /** The display under a physical point, with its rect in physical px. */
  displayAt(phys: { x: number; y: number }): { id: number; rect: Rect } | null {
    const d = displayAtPhysical(phys.x, phys.y, this.maps);
    return d ? { id: d.id, rect: { x: d.phys.x, y: d.phys.y, w: d.phys.width, h: d.phys.height } } : null;
  }

  /** A physical point in CSS px inside the overlay of the display under it. */
  toLocal(phys: { x: number; y: number }): LocalPoint | null {
    return physicalToLocal(phys.x, phys.y, this.maps);
  }

  /** A physical point as a screen point in DIPs, where the teammate's windows are placed. */
  toDip(phys: { x: number; y: number }): { x: number; y: number } | null {
    const p = physicalToDip(phys.x, phys.y, this.maps);
    return p ? { x: p.x, y: p.y } : null;
  }

  /** The middle of the main display in DIPs: where the teammate's windows go when no display is under a spot. */
  primaryDip(): { x: number; y: number } {
    const b = screen.getPrimaryDisplay().bounds;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  /** Shows an emote in the middle of the main display, without sharing it (the settings page's preview). */
  previewEmote(ref: EmoteRef): void {
    const d = screen.getPrimaryDisplay();
    this.send(d.id, 'emote:spawn', { owner: 'preview', art: this.resolveArt(ref, false), x: d.bounds.width / 2, y: d.bounds.height / 2 });
  }

  /** A room member's emote, already mapped onto one of our displays. It replaces their earlier one, whichever display that was on. */
  spawnRemoteEmote(p: { displayId: number; x: number; y: number; ref: EmoteRef; fx?: number; peer: string; tag: PingTag; silent?: boolean }): void {
    const art = this.resolveArt(p.ref, true);
    // The effect is the sender's choice, so the one on their message wins — over a cached still's plain pop, and over
    // the effect we picked if we happen to have the same image imported.
    const withFx = art.kind === 'custom' ? { ...art, fx: p.fx ?? 0 } : art;
    this.send(p.displayId, 'emote:spawn', { owner: p.peer, art: withFx, x: p.x, y: p.y, tag: p.tag, ...(p.silent ? { silent: true } : {}) });
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

  markerBlocked(text: string, displayId: number): void { this.send(displayId, 'marker:blocked', { text }); }

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
    this.wheelAt = null;
  }

  /** Our own ping placed from here, kept if that setting is on, and shared with the room. */
  private placeOwnPing(id: PingId, p: LocalPoint): void {
    const admission = this.admitMarker(p);
    if (!admission.allowed) return;
    const keep = this.settings.keepLastPing ? { keep: true } : {};
    this.send(p.displayId, 'ping:spawn', { id, x: p.x, y: p.y, ...keep, ...(admission.silent ? { silent: true } : {}) });
    this.unkeepElsewhere(p.displayId);
    this.emit('shared', { id, displayId: p.displayId, x: p.x, y: p.y, ...(admission.batch ? { batch: admission.batch } : {}) } satisfies SharedPing);
  }

  private placeOwnEmote(ref: EmoteRef, p: LocalPoint): void {
    const admission = this.admitMarker(p);
    if (!admission.allowed) return;
    this.send(p.displayId, 'emote:spawn', {
      owner: 'self', art: this.resolveArt(ref, false), x: p.x, y: p.y, ...(admission.silent ? { silent: true } : {}),
    });
    this.clearElsewhere(p.displayId, 'self');
    this.emit('sharedEmote', { ref, displayId: p.displayId, x: p.x, y: p.y, ...(admission.batch ? { batch: admission.batch } : {}) } satisfies SharedEmote);
  }

  /** The slice is worked out here from the same geometry the wheel draws, so the overlay has nothing to report. */
  private askReleased(at: LocalPoint): void {
    const open = this.wheelAt;
    if (!open || open.local.displayId !== at.displayId) return;
    const slice = pickSlice(at.x - open.local.x, at.y - open.local.y, (WHEEL.innerR * this.settings.wheelSizePx) / WHEEL.size);
    const id = slice >= 0 ? this.settings.wheel[slice] : undefined;
    if (id === undefined) return;
    if (this.settings.ask.disabled.includes(id)) {
      // On the ping key a switched-off intent is just a ping, as it was before the teammate.
      if (this.settings.ask.onPing) this.placeOwnPing(id, open.local);
      return;
    }
    const { displayId, x, y } = open.local;
    this.emit('askRelease', { displayId, x, y, phys: open.phys, id } satisfies AskRelease);
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
      if (win) this.place(win, d);
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
    if (this.captureExcluded) win.setContentProtection(true);
    if (IS_LINUX) win.setVisibleOnAllWorkspaces(true);
    if (IS_MAC) {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.setHiddenInMissionControl(true); // the overlay isn't a window to the user: keep it out of Mission Control
    }
    win.webContents.on('did-finish-load', () => win.webContents.send('overlay:settings', this.settings));
    win.once('ready-to-show', () => {
      if (!HIDDEN_TEST_RUN) win.showInactive();
      this.place(win, d); // re-apply: mixed-DPI setups can size the first frame wrong
    });
    void loadPage(win, 'overlay');
    return win;
  }

  /** Over its display, or parked off it while its page has nothing on it (Windows only). */
  private place(win: BrowserWindow, d: Display): void {
    if (!this.idleWindows.has(win)) {
      win.setBounds(overlayBounds(d));
      return;
    }
    const others = screen.getAllDisplays().filter((o) => o.id !== d.id).map((o) => o.bounds);
    const parked = parkedBounds(d.bounds, overlayBounds(d), others);
    if (parked) win.setBounds(parked);
    else win.hide(); // boxed in by other displays: hidden instead, show animation and all
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
