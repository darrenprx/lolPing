import { BrowserWindow, ipcMain, screen, type Display } from 'electron';
import { ANSWER_CLOSE, type AnswerEvents } from '../shared/ipc';
import { IS_MAC, loadPage, preloadPath } from './paths';

export type AnswerState = AnswerEvents['answer:state'];

export interface AnswerManagerDeps {
  /** Runs when the user closed the answer, so a pending request can stop talking to a dead window. */
  onClosed?(): void;
}

/** One window that shows the AI answer: a fullscreen mask or a corner card, in loading, done and error states. */
export class AnswerManager {
  private win: BrowserWindow | null = null;
  private mode: AnswerState['mode'] = 'fullscreen';
  /** The latest state, so a window that is still loading can be caught up when it finishes. */
  private last: { displayId: number; state: AnswerState } | null = null;

  constructor(private readonly d: AnswerManagerDeps = {}) {
    ipcMain.on(ANSWER_CLOSE, (event) => {
      if (this.win && !this.win.isDestroyed() && event.sender === this.win.webContents) this.close();
    });
  }

  /** Whether an answer is on screen right now. */
  isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  /** Shows (or updates) the answer on `displayId`. A second show reuses the window, so loading flows into the answer. */
  show(displayId: number, state: AnswerState): void {
    const display = screen.getAllDisplays().find((x) => x.id === displayId) ?? screen.getPrimaryDisplay();
    this.last = { displayId, state };
    this.mode = state.mode;
    if (this.win === null || this.win.isDestroyed()) {
      this.win = this.createWindow(display, state.mode);
    }
    this.win.setBounds(this.boundsFor(display, state.mode));
    this.win.webContents.send('answer:state', state);
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.d.onClosed?.();
  }

  private boundsFor(display: Display, mode: AnswerState['mode']): Electron.Rectangle {
    if (mode === 'fullscreen') return display.bounds;
    // A card in the bottom-right corner, one card's width and a comfortable margin from the edges.
    const width = 430;
    const height = 320;
    const margin = 28;
    return {
      x: display.bounds.x + display.bounds.width - width - margin,
      y: display.bounds.y + display.bounds.height - height - margin,
      width,
      height,
    };
  }

  private createWindow(display: Display, mode: AnswerState['mode']): BrowserWindow {
    const win = new BrowserWindow({
      ...this.boundsFor(display, mode),
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
      webPreferences: { preload: preloadPath('answer'), backgroundThrottling: false, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // A state shown before the page finishes loading would be lost: catch the page up when it is there.
    win.webContents.on('did-finish-load', () => {
      if (this.win === win && this.last?.state) win.webContents.send('answer:state', this.last.state);
    });
    win.once('ready-to-show', () => {
      if (this.win === win) win.show(); // focused, so Esc reaches the page at once
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.d.onClosed?.();
      }
    });
    void loadPage(win, 'answer');
    return win;
  }
}
