import { BrowserWindow, ipcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomMediaBridge } from '../../src/main/roomMediaBridge';
import { MEDIA_CH, type MediaCommand, type MediaSignal } from '../../src/shared/roomMedia';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const windows: Window[] = [];
  class Window {
    dead = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(),
    });
    constructor() { windows.push(this); }
    static getAllWindows() { return windows.filter((w) => !w.dead); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; }
  }
  return {
    BrowserWindow: Window, ipcMain: new EventEmitter(), net: { fetch: vi.fn() },
    session: { fromPartition: () => ({
      protocol: { handle: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    }) },
  };
});
vi.mock('../../src/main/paths', () => ({ loadPage: async () => {}, preloadPath: () => 'media.js' }));

const peer = 'b'.repeat(16);
const signal: MediaSignal = { id: '1'.repeat(16), type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' };
const bridges: RoomMediaBridge[] = [];
function harness() {
  const bridge = new RoomMediaBridge({ signal: () => {}, packet: () => {}, changed: () => {} });
  bridges.push(bridge);
  bridge.configure('a'.repeat(16), { iceServers: [], iceTransportPolicy: 'all' }, [peer]);
  const win = BrowserWindow.getAllWindows()[0];
  const commands: MediaCommand[] = [];
  vi.mocked(win.webContents.send).mockImplementation((_channel, command: MediaCommand) => { commands.push(command); });
  const ready = () => ipcMain.emit(MEDIA_CH.event, { sender: win.webContents, senderFrame: win.webContents.mainFrame }, { t: 'ready' });
  return { bridge, win, commands, ready };
}
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.stop(); });

describe('RoomMediaBridge', () => {
  it('delivers the latest early signal after reset and peer setup once the worker is ready', () => {
    const h = harness();
    h.bridge.signal(peer, { ...signal, id: '2'.repeat(16) });
    h.bridge.signal(peer, signal);
    h.bridge.signal('c'.repeat(16), signal);
    expect(h.commands).toEqual([]);
    h.ready();
    expect(h.commands.map((c) => c.t)).toEqual(['reset', 'peers', 'signal']);
    expect(h.commands[2]).toEqual({ t: 'signal', peer, signal });
  });

  it('forgets an early signal if its peer leaves before the worker is ready', () => {
    const h = harness();
    h.bridge.signal(peer, signal);
    h.bridge.configure('a'.repeat(16), { iceServers: [], iceTransportPolicy: 'all' }, ['c'.repeat(16)]);
    h.ready();
    expect(h.commands.map((c) => c.t)).toEqual(['reset', 'peers']);
  });

  it('destroys the worker and clears connected status when no media peers remain', () => {
    const h = harness(); h.ready();
    ipcMain.emit(MEDIA_CH.event, { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame },
      { t: 'status', peer, status: 'connected' });
    expect(h.bridge.status(peer)).toBe('connected');
    h.bridge.configure('a'.repeat(16), { iceServers: [], iceTransportPolicy: 'all' }, []);
    expect(h.win.isDestroyed()).toBe(true);
    expect(h.bridge.status(peer)).toBe('off');
  });

  it('ignores ready events from another window or a child frame', () => {
    const h = harness();
    h.bridge.signal(peer, signal);
    ipcMain.emit(MEDIA_CH.event, { sender: {}, senderFrame: h.win.webContents.mainFrame }, { t: 'ready' });
    ipcMain.emit(MEDIA_CH.event, { sender: h.win.webContents, senderFrame: {} }, { t: 'ready' });
    expect(h.commands).toEqual([]);
    h.ready();
    expect(h.commands.at(-1)).toEqual({ t: 'signal', peer, signal });
  });
});
