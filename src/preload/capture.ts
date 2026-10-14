import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureEvents, CaptureRect } from '../shared/ipc';

// Inlined rather than imported: a sandboxed preload can't require a shared chunk, and ipc.ts is
// shared with the overlay preload. Keep these in sync with src/shared/ipc.ts.
const CAPTURE_BEGIN = 'capture:begin';
const CAPTURE_CONFIRM = 'capture:confirm';
const CAPTURE_CANCEL = 'capture:cancel';
const CAPTURE_CHANNELS = [CAPTURE_BEGIN];

const api = {
  on<C extends keyof CaptureEvents>(channel: C, cb: (payload: CaptureEvents[C]) => void): void {
    if (!CAPTURE_CHANNELS.includes(channel)) throw new Error(`unknown capture channel: ${channel}`);
    ipcRenderer.on(channel, (_event, payload: CaptureEvents[C]) => cb(payload));
  },
  /** The user confirmed `rect` (CSS px in this display): shoot it and ask the AI. */
  confirm(rect: CaptureRect): void {
    ipcRenderer.send(CAPTURE_CONFIRM, rect);
  },
  /** The user dismissed the capture. */
  cancel(): void {
    ipcRenderer.send(CAPTURE_CANCEL, null);
  },
};

contextBridge.exposeInMainWorld('capture', api);

export type CaptureApi = typeof api;
