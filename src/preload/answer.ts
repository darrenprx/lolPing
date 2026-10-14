import { contextBridge, ipcRenderer } from 'electron';
import type { AnswerEvents } from '../shared/ipc';

// Inlined rather than imported: a sandboxed preload can't require a shared chunk, and ipc.ts is
// shared with the overlay preload. Keep these in sync with src/shared/ipc.ts.
const ANSWER_STATE = 'answer:state';
const ANSWER_CLOSE = 'answer:close';
const ANSWER_CHANNELS = [ANSWER_STATE];

const api = {
  on<C extends keyof AnswerEvents>(channel: C, cb: (payload: AnswerEvents[C]) => void): void {
    if (!ANSWER_CHANNELS.includes(channel)) throw new Error(`unknown answer channel: ${channel}`);
    ipcRenderer.on(channel, (_event, payload: AnswerEvents[C]) => cb(payload));
  },
  /** The user closed the answer (click, Esc, or the card's timer). */
  close(): void {
    ipcRenderer.send(ANSWER_CLOSE, null);
  },
};

contextBridge.exposeInMainWorld('answer', api);

export type AnswerApi = typeof api;
