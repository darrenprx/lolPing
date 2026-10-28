import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import type { Lang } from '../shared/i18n';
import { SHOT_CH, type ShotImageView, type ShotViewState } from '../shared/ipc';
import { shotPlacement, type RoomShotSettings } from '../shared/roomShots';
import { loadPage, pageUrl, preloadPath } from './paths';

interface Card {
  key: string; peer: string; state: ShotViewState; at: { x: number; y: number }; display: number;
  win: BrowserWindow; loaded: boolean; hovered: boolean; expires: number;
  revisions: Map<number, number>;
}

/** Only the small card accepts clicks. Showing it never takes focus from the app underneath. */
export class ShotWindows {
  private readonly cards = new Map<string, Card>();
  private readonly dismissed = new Set<string>();
  private viewer: { win: BrowserWindow; key: string; loaded: boolean } | null = null;
  private excluded = false;
  constructor(private readonly deps: {
    now(): number; settings(): RoomShotSettings; lang(): Lang;
    target(d: number): { displayId: number; width: number; height: number } | null;
    /** Native-window regression harness: renders the real pages without showing or focusing a desktop window. */
    hidden?: boolean;
  }) {
    ipcMain.on(SHOT_CH.action, this.onAction);
    ipcMain.on(SHOT_CH.ready, this.onReady);
  }

  update(peer: string, name: string, image: ShotImageView): void {
    const key = `${peer}:${image.meta.id}`;
    if (this.dismissed.has(key)) return;
    const target = this.deps.target(image.meta.d);
    if (!target) return;
    let card = this.cards.get(key);
    if (!card) {
      while (this.cards.size >= 3) {
        const first = [...this.cards.keys()].find((k) => k !== this.viewer?.key) ?? this.cards.keys().next().value;
        if (first) this.closeCard(first);
      }
      const display = screen.getAllDisplays().find((d) => d.id === target.displayId) ?? screen.getPrimaryDisplay();
      const capacity = Math.max(1, Math.min(3, Math.floor((display.workArea.height - 16) / 278)));
      const sameDisplay = [...this.cards.values()].filter((c) => c.display === display.id);
      if (sameDisplay.length >= capacity) this.closeCard((sameDisplay.find((c) => c.key !== this.viewer?.key) ?? sameDisplay[0]).key);
      const at = { x: display.bounds.x + image.meta.x * target.width, y: display.bounds.y + image.meta.y * target.height };
      const rect = shotPlacement(display.workArea, at, this.deps.settings().placement);
      const win = this.create('card', rect);
      card = { key, peer, state: { view: 'card', key, name, lang: this.deps.lang(), images: [] },
        at, display: display.id, win, loaded: false, hovered: false, expires: this.deps.now() + this.deps.settings().lifetimeMs,
        revisions: new Map() };
      this.cards.set(key, card);
      win.once('closed', () => { if (this.cards.get(key)?.win === win) this.closeCard(key, false); });
      this.bindLoad(win);
    }
    const old = card.state.images.find((i) => i.meta.d === image.meta.d);
    if ((card.revisions.get(image.meta.d) ?? 0) > image.meta.rev) return;
    card.revisions.set(image.meta.d, image.meta.rev);
    const images = card.state.images.filter((i) => i.meta.d !== image.meta.d);
    // Keep the last usable image while its replacement loads or fails. Its markers stay on its own coordinate frame.
    images.push(old?.data && image.status !== 'ready' ? { ...old, status: image.status } : image);
    images.sort((a, b) => a.meta.d - b.meta.d);
    card.state = { ...card.state, name, lang: this.deps.lang(), images: images.slice(-8) };
    // Loading has a bounded transfer deadline; the normal display timer starts once an image or error arrives.
    card.expires = this.deps.now() + (image.status === 'loading' ? 46_000 : this.deps.settings().lifetimeMs);
    this.reposition();
    this.push(card);
    this.pushViewer();
  }

  tick(): void {
    for (const [key, c] of this.cards) if (!c.hovered && this.viewer?.key !== key && this.deps.now() >= c.expires) this.closeCard(key);
  }

  reconfigure(): void {
    this.reposition();
    for (const c of this.cards.values()) { c.state.lang = this.deps.lang(); this.push(c); }
    this.pushViewer();
  }

  setCaptureExcluded(on: boolean): void {
    this.excluded = on;
    for (const c of this.cards.values()) if (!c.win.isDestroyed()) c.win.setContentProtection(on);
    if (this.viewer && !this.viewer.win.isDestroyed()) this.viewer.win.setContentProtection(on);
  }

  contains(at: { x: number; y: number }): boolean {
    return [...this.cards.values()].some((c) => {
      const r = c.win.getBounds();
      return at.x >= r.x && at.x < r.x + r.width && at.y >= r.y && at.y < r.y + r.height;
    });
  }

  forget(peer: string): void {
    for (const [key, card] of this.cards) if (card.peer === peer) this.closeCard(key);
  }

  clear(): void {
    for (const key of [...this.cards.keys()]) this.closeCard(key);
    this.dismissed.clear();
    this.closeViewer();
  }

  destroy(): void {
    this.clear();
    ipcMain.removeListener(SHOT_CH.action, this.onAction);
    ipcMain.removeListener(SHOT_CH.ready, this.onReady);
  }

  private closeCard(key: string, destroy = true): void {
    const card = this.cards.get(key);
    if (!card) return;
    this.cards.delete(key);
    this.dismissed.add(key);
    while (this.dismissed.size > 128) { const first = this.dismissed.values().next().value; if (first) this.dismissed.delete(first); }
    if (destroy && !card.win.isDestroyed()) card.win.destroy();
    if (this.viewer?.key === key) this.closeViewer();
    this.reposition();
  }

  private closeViewer(): void {
    const viewer = this.viewer;
    this.viewer = null;
    if (viewer && !viewer.win.isDestroyed()) viewer.win.destroy();
  }

  private open(card: Card): void {
    if (!card.state.images.some((i) => i.data)) return;
    this.closeViewer();
    const d = screen.getAllDisplays().find((d) => d.id === card.display) ?? screen.getPrimaryDisplay();
    const a = d.workArea, width = Math.min(1200, Math.floor(a.width * 0.85)), height = Math.min(900, Math.floor(a.height * 0.85));
    const win = this.create('viewer', { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height });
    this.viewer = { win, key: card.key, loaded: false };
    win.once('closed', () => {
      if (this.viewer?.win === win) this.viewer = null;
      card.expires = this.deps.now() + this.deps.settings().lifetimeMs;
    });
    this.bindLoad(win);
  }

  private push(card: Card): void {
    if (!card.loaded || card.win.isDestroyed()) return;
    card.win.webContents.send(SHOT_CH.state, card.state);
    if (!this.deps.hidden && !card.win.isVisible()) card.win.showInactive();
  }

  private pushViewer(): void {
    const v = this.viewer;
    const card = v && this.cards.get(v.key);
    if (v?.loaded && card && !v.win.isDestroyed()) v.win.webContents.send(SHOT_CH.state, { ...card.state, view: 'viewer' });
  }

  private reposition(): void {
    const counts = new Map<number, number>();
    for (const c of [...this.cards.values()].reverse()) {
      const d = screen.getAllDisplays().find((d) => d.id === c.display) ?? screen.getPrimaryDisplay();
      const index = counts.get(d.id) ?? 0;
      counts.set(d.id, index + 1);
      if (!c.win.isDestroyed()) c.win.setBounds(shotPlacement(d.workArea, c.at, this.deps.settings().placement, index));
    }
  }

  private create(view: 'card' | 'viewer', rect: Electron.Rectangle): BrowserWindow {
    const w = new BrowserWindow({ ...rect, show: false, frame: false, transparent: view === 'card',
      backgroundColor: view === 'card' ? '#00000000' : '#172131', resizable: view === 'viewer',
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      alwaysOnTop: true, focusable: view === 'viewer',
      webPreferences: { preload: preloadPath('shots'), spellcheck: false, sandbox: true, contextIsolation: true, nodeIntegration: false,
        ...(this.deps.hidden ? { offscreen: true, backgroundThrottling: false } : {}) },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setContentProtection(this.excluded);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const own = new URL(pageUrl('shots'));
    w.webContents.on('will-navigate', (e) => {
      try { const next = new URL(e.url); if (next.protocol !== own.protocol || next.host !== own.host || next.pathname !== own.pathname) e.preventDefault(); }
      catch { e.preventDefault(); }
    });
    return w;
  }

  private bindLoad(w: BrowserWindow): void {
    const drop = (): void => {
      // A crashed renderer can be recreated by the next update of the same group. Explicit dismissal stays dismissed.
      const card = [...this.cards.values()].find((c) => c.win === w);
      if (card) { this.cards.delete(card.key); if (this.viewer?.key === card.key) this.closeViewer(); }
      if (!w.isDestroyed()) w.destroy();
    };
    w.webContents.once('did-fail-load', drop);
    w.webContents.once('render-process-gone', drop);
    void loadPage(w, 'shots').catch(drop);
  }

  private readonly onReady = (event: IpcMainEvent): void => {
    const card = [...this.cards.values()].find((c) => c.win.webContents === event.sender);
    if (card) { card.loaded = true; this.push(card); return; }
    const viewer = this.viewer;
    if (viewer?.win.webContents === event.sender) {
      viewer.loaded = true;
      this.pushViewer();
      if (!this.deps.hidden) viewer.win.show(); // the viewer was opened by an explicit click
    }
  };

  private readonly onAction = (event: IpcMainEvent, raw: unknown): void => {
    const card = [...this.cards.values()].find((c) => c.win.webContents === event.sender);
    if (card) {
      if (raw === 'open') this.open(card);
      else if (raw === 'close') this.closeCard(card.key);
      else if (raw === 'enter') card.hovered = true;
      else if (raw === 'leave') { card.hovered = false; card.expires = this.deps.now() + this.deps.settings().lifetimeMs; }
    } else if (raw === 'close' && this.viewer?.win.webContents === event.sender) this.closeViewer();
  };
}
