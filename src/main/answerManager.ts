import { BrowserWindow, ipcMain, screen, type Display } from 'electron';
import { ANSWER_ASK, ANSWER_CLOSE, type AnswerState, type AnswerTurn } from '../shared/ipc';
import { chatCompletion, imageMessage, textMessage, trimMessages, type AiVisionResult, type ChatMessage } from './aiVision';
import { IS_MAC, loadPage, preloadPath } from './paths';

/** The settings- and language-driven shell around the conversation; index.ts computes it. */
export interface AnswerFrame {
  mode: 'fullscreen' | 'card';
  title: string;
  askPlaceholder: string;
  fontSize: number;
  closeHint: string;
  cardSeconds: number;
  showThumbnail: boolean;
}

export interface AnswerManagerDeps {
  /** The AI call for the current conversation, with the settings as they are right now. */
  request(messages: readonly ChatMessage[]): Promise<AiVisionResult>;
  /** The user-facing line for a failed round, in the app language. */
  errorText(result: Extract<AiVisionResult, { ok: false }>): string;
  onClosed?(): void;
}

/**
 * The AI answer window: a fullscreen mask or a corner card showing the conversation about one capture.
 * Owns the conversation (first message carries the image); `ask` runs a follow-up through the model.
 * Closing the window discards it — the next capture starts a fresh conversation.
 */
export class AnswerManager {
  private win: BrowserWindow | null = null;
  private frame: AnswerFrame = {
    mode: 'fullscreen', title: '', askPlaceholder: '', fontSize: 15, closeHint: '', cardSeconds: 10, showThumbnail: true,
  };
  private displayId = 0;
  private messages: ChatMessage[] = [];
  private turns: AnswerTurn[] = [];
  private thumbnail = '';
  private pending = false;
  /** Increments on close, so requests that outlive the window stop talking about a discarded conversation. */
  private generation = 0;
  /** The last payload sent, so a window that is still loading can be caught up when it finishes. */
  /** The last payload sent and the display it belongs to, so a still-loading window can be caught up. */
  private last: { displayId: number; state: AnswerState } | null = null;

  constructor(private readonly d: AnswerManagerDeps) {
    ipcMain.on(ANSWER_CLOSE, (event) => {
      if (this.win && !this.win.isDestroyed() && event.sender === this.win.webContents) this.close();
    });
    ipcMain.on(ANSWER_ASK, (event, raw: unknown) => {
      if (this.win && !this.win.isDestroyed() && event.sender === this.win.webContents) void this.ask(raw);
    });
  }

  /** Whether an answer is on screen right now. */
  isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  /** Starts a fresh conversation about a capture: the prompt and image are round one. */
  begin(displayId: number, frame: AnswerFrame, prompt: string, jpeg: Buffer, thumbnailDataUrl: string): void {
    this.generation++;
    this.displayId = displayId;
    this.applyFrame(frame);
    this.messages = [imageMessage(prompt, jpeg)];
    this.thumbnail = frame.showThumbnail ? thumbnailDataUrl : '';
    this.turns = [{ q: prompt, a: '', pending: true, error: false }];
    this.pending = true;
    this.push();
    void this.settle();
  }

  /** A follow-up from the input box. Ignored while a round is pending or with nothing to say. */
  async ask(raw: unknown): Promise<void> {
    const text = typeof raw === 'string' ? raw.trim().slice(0, 2000) : '';
    if (this.pending || text === '' || this.messages.length === 0) return;
    const gen = this.generation;
    this.messages.push(textMessage('user', text));
    this.turns.push({ q: text, a: '', pending: true, error: false });
    this.pending = true;
    this.push();
    const result = await this.d.request(trimMessages(this.messages));
    this.complete(result, gen);
  }

  /** Fills in the round that was pending, or takes a failed question back out for a clean retry. */
  private complete(result: AiVisionResult, gen: number): void {
    if (gen !== this.generation) return; // the window was closed while the model was thinking
    const turn = this.turns[this.turns.length - 1];
    if (!turn) return;
    if (result.ok) {
      this.messages.push(textMessage('assistant', result.text));
      turn.a = result.text;
      turn.pending = false;
      turn.error = false;
    } else {
      this.messages.pop();
      turn.a = this.d.errorText(result);
      turn.pending = false;
      turn.error = true;
    }
    this.pending = this.turns.some((t) => t.pending);
    this.push();
  }

  close(): void {
    this.generation++;
    this.messages = [];
    this.turns = [];
    this.thumbnail = '';
    this.pending = false;
    this.last = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.d.onClosed?.();
  }

  private async settle(): Promise<void> {
    const gen = this.generation;
    const result = await this.d.request(trimMessages(this.messages));
    this.complete(result, gen);
  }

  private applyFrame(frame: AnswerFrame): void {
    this.frame = { ...frame };
  }

  /** Re-renders with a new shell (mode, texts, sizes) around the conversation as it is. */
  updateFrame(displayId: number, frame: AnswerFrame): void {
    this.displayId = displayId;
    this.applyFrame(frame);
    if (this.win !== null) this.push();
  }

  private push(): void {
    const display = screen.getAllDisplays().find((x) => x.id === this.displayId) ?? screen.getPrimaryDisplay();
    const state: AnswerState = {
      mode: this.frame.mode,
      title: this.frame.title,
      thumbnail: this.thumbnail,
      turns: this.turns.map((t) => ({ ...t })),
      askPlaceholder: this.frame.askPlaceholder,
      fontSize: this.frame.fontSize,
      closeHint: this.frame.closeHint,
      cardSeconds: this.frame.cardSeconds,
    };
    this.last = { displayId: this.displayId, state };
    if (this.win === null || this.win.isDestroyed()) this.win = this.createWindow(display, state.mode);
    this.win.setBounds(this.boundsFor(display, state.mode));
    this.win.webContents.send('answer:state', state);
  }

  private boundsFor(display: Display, mode: AnswerState['mode']): Electron.Rectangle {
    if (mode === 'fullscreen') return display.bounds;
    // A card in the bottom-right corner, one card's size and a comfortable margin from the edges.
    const width = 440;
    const height = 520;
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
      if (this.win === win && this.last) win.webContents.send('answer:state', this.last.state);
    });
    win.once('ready-to-show', () => {
      if (this.win === win) win.show(); // focused, so typing and Esc reach the page at once
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
