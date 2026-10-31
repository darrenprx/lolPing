import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { EventEmitter } from 'node:events';
import { PANEL_CH, parsePanelAction, type PanelAction, type PanelState } from '../shared/ipc';
import type { Rect } from './coords';
import { IS_LINUX, IS_MAC, loadPage, pageUrl, preloadPath } from './paths';
import { centredIn, ROSTER_SIZE, votePlacement } from './panelPlacement';

type View = PanelState['view'];

/** What each window may ask for: the vote widget only answers, the roster does the rest. */
const ALLOWED: Record<View, ReadonlySet<PanelAction['t']>> = {
  vote: new Set(['ballot']),
  roster: new Set(['alive', 'mute', 'kick', 'vote']),
};

interface Slot {
  win: BrowserWindow | null;
  loaded: boolean;
  /** The latest state; sent as soon as the page has loaded, and again by `update`. */
  state: PanelState | null;
  /** The window should be on screen: it shows once its page has loaded. */
  shown: boolean;
}

const emptySlot = (): Slot => ({ win: null, loaded: false, state: null, shown: false });

/**
 * The roster and the vote widget: two small windows that take clicks without taking focus, so the game or editor
 * underneath keeps the keyboard. Each is created when first shown and kept hidden after that.
 * Emits 'action' with a validated PanelAction.
 */
export class PanelWindows extends EventEmitter {
  private readonly slots: Record<View, Slot> = { roster: emptySlot(), vote: emptySlot() };

  constructor() {
    super();
    ipcMain.on(PANEL_CH.action, this.onAction);
  }

  showVote(state: PanelState): void {
    const kind = state.vote?.kind;
    if (!kind) return this.hideVote();
    this.show('vote', votePlacement(kind, screen.getPrimaryDisplay().workArea), state);
  }

  hideVote(): void {
    this.hide('vote');
  }

  /** Centred on the display under `at`, the cursor. */
  showRoster(at: { x: number; y: number }, state: PanelState): void {
    this.show('roster', centredIn(ROSTER_SIZE, screen.getDisplayNearestPoint(at).workArea), state);
  }

  hideRoster(): void {
    this.hide('roster');
  }

  /** Sends a new state to a window that is already up; nothing happens for one that isn't. */
  update(state: PanelState): void {
    const slot = this.slots[state.view];
    if (!slot.shown) return;
    slot.state = state;
    this.push(slot);
  }

  destroyWindows(): void {
    for (const view of ['roster', 'vote'] as const) {
      this.hide(view);
    }
  }

  destroy(): void {
    ipcMain.removeListener(PANEL_CH.action, this.onAction);
    this.destroyWindows();
  }

  private show(view: View, rect: Rect, state: PanelState): void {
    const slot = this.slots[view];
    slot.state = state;
    slot.shown = true;
    const w = slot.win && !slot.win.isDestroyed() ? slot.win : this.create(view, slot, rect);
    w.setBounds(rect);
    if (!slot.loaded) return; // 'did-finish-load' sends the state and shows the window
    this.push(slot);
    this.reveal(w);
  }

  private hide(view: View): void {
    const slot = this.slots[view];
    slot.shown = false;
    if (!slot.win || slot.win.isDestroyed()) return;
    const w = slot.win;
    slot.win = null;
    slot.loaded = false;
    slot.state = null;
    w.destroy();
  }

  private push(slot: Slot): void {
    if (slot.win && !slot.win.isDestroyed() && slot.loaded && slot.state) slot.win.webContents.send(PANEL_CH.state, slot.state);
  }

  private reveal(w: BrowserWindow): void {
    // Windows can drop an always-on-top window behind normal ones after a while (#70): set the level again each time.
    w.setAlwaysOnTop(true, 'screen-saver');
    w.showInactive();
  }

  private create(view: View, slot: Slot, rect: Rect): BrowserWindow {
    const w = new BrowserWindow({
      ...rect,
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
      // Clicks reach the page, but the window never becomes the active one: whatever the user was typing into keeps the keyboard.
      focusable: false,
      show: false,
      // macOS: a non-activating panel is what keeps the active app unchanged. Not checked on a Mac yet.
      ...(IS_MAC ? { type: 'panel' as const } : {}),
      webPreferences: { preload: preloadPath('panel'), spellcheck: false },
    });
    slot.win = w;
    slot.loaded = false;
    w.setIgnoreMouseEvents(false);
    w.setAlwaysOnTop(true, 'screen-saver'); // above the overlay and a game's borderless window
    if (IS_LINUX) w.setVisibleOnAllWorkspaces(true);
    if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.on('closed', () => {
      if (slot.win === w) this.slots[view] = emptySlot();
    });
    w.webContents.on('did-finish-load', () => {
      slot.loaded = true;
      if (!slot.shown) return;
      this.push(slot);
      this.reveal(w);
    });
    const drop = (): void => {
      if (!w.isDestroyed()) w.destroy();
    };
    w.webContents.on('did-fail-load', drop);
    w.webContents.on('render-process-gone', drop);
    const own = new URL(pageUrl('panel'));
    w.webContents.on('will-navigate', (event) => {
      try {
        const target = new URL(event.url);
        if (target.protocol !== own.protocol || target.host !== own.host || target.pathname !== own.pathname) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loadPage(w, 'panel').catch(drop);
    return w;
  }

  private readonly onAction = (event: IpcMainEvent, raw: unknown): void => {
    const view = (['roster', 'vote'] as const).find((v) => this.slots[v].win?.webContents === event.sender);
    if (!view) return;
    const action = parsePanelAction(raw);
    if (action && ALLOWED[view].has(action.t)) this.emit('action', action);
  };
}
