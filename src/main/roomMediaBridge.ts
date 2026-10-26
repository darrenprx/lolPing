import { BrowserWindow, ipcMain, net, session, type IpcMainEvent } from 'electron';
import { parseMediaSignal, MEDIA_CH, type MediaCommand, type MediaConfig, type MediaSignal, type MediaStatus } from '../shared/roomMedia';
import { loadPage, preloadPath } from './paths';
import { APP_SCHEME } from './appProtocol';

let nextPartition = 0;

interface Callbacks {
  signal(peer: string, signal: MediaSignal): void;
  packet(peer: string, bytes: Uint8Array): void;
  changed(): void;
}

/** Owns a sandboxed data-only Chromium worker; no room key or filesystem API crosses this bridge. */
export class RoomMediaBridge {
  private win: BrowserWindow | null = null;
  private ready = false;
  private self = '';
  private config: MediaConfig = { iceServers: [], iceTransportPolicy: 'all' };
  private peers: string[] = [];
  private states = new Map<string, MediaStatus>();
  private pendingSignals = new Map<string, MediaSignal>();
  private signature = '';
  private failed = false;
  private readonly isolated = session.fromPartition(`room-media-${++nextPartition}`);

  constructor(private readonly callbacks: Callbacks) {
    // Custom protocols belong to a session. Forward app assets to the already restricted default handler.
    this.isolated.protocol.handle(APP_SCHEME, (request) => net.fetch(request.url));
    this.isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.isolated.setPermissionCheckHandler(() => false);
    ipcMain.on(MEDIA_CH.event, this.event);
  }

  status(peer: string): MediaStatus { return this.states.get(peer) ?? 'off'; }

  configure(self: string, config: MediaConfig, peers: string[]): void {
    const signature = JSON.stringify([self, config]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.destroy();
      this.failed = false;
    }
    const changed = JSON.stringify(this.peers) !== JSON.stringify(peers);
    this.self = self;
    this.config = config;
    this.peers = [...peers];
    for (const peer of this.states.keys()) if (!peers.includes(peer)) this.states.delete(peer);
    for (const peer of this.pendingSignals.keys()) if (!peers.includes(peer)) this.pendingSignals.delete(peer);
    if (!peers.length) { this.destroy(); return; }
    if (!this.win && !this.failed) this.create();
    else if (changed) this.send({ t: 'peers', peers });
  }

  signal(peer: string, signal: MediaSignal): void {
    if (!this.peers.includes(peer)) return;
    if (!this.ready) this.pendingSignals.set(peer, signal);
    else this.send({ t: 'signal', peer, signal });
  }

  sendPacket(peer: string, bytes: Uint8Array): void {
    if (this.status(peer) === 'connected' && this.peers.includes(peer) && bytes.length <= 1200) {
      this.send({ t: 'packet', peer, bytes });
    }
  }

  retry(): void { this.destroy(); this.failed = false; if (this.peers.length) this.create(); }
  stop(): void { this.peers = []; this.destroy(); ipcMain.removeListener(MEDIA_CH.event, this.event); }

  private create(): void {
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: preloadPath('media'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, session: this.isolated,
    } });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', () => {
      if (this.win !== win) return;
      this.destroy();
      this.failed = true;
      for (const peer of this.peers) this.states.set(peer, 'failed');
      this.callbacks.changed();
    });
    void loadPage(win, 'media').catch(() => {
      if (this.win !== win) return;
      this.destroy();
      this.failed = true;
      for (const peer of this.peers) this.states.set(peer, 'failed');
      this.callbacks.changed();
    });
  }

  private send(command: MediaCommand): void {
    if (this.ready && this.win && !this.win.isDestroyed()) this.win.webContents.send(MEDIA_CH.command, command);
  }

  private event = (event: IpcMainEvent, raw: unknown): void => {
    if (!this.win || event.sender !== this.win.webContents || event.senderFrame !== this.win.webContents.mainFrame) return;
    if (typeof raw !== 'object' || raw === null) return;
    const r = raw as Record<string, unknown>;
    if (r.t === 'ready') {
      this.ready = true;
      this.send({ t: 'reset', self: this.self, config: this.config });
      this.send({ t: 'peers', peers: this.peers });
      for (const [peer, signal] of this.pendingSignals) this.send({ t: 'signal', peer, signal });
      this.pendingSignals.clear();
      return;
    }
    if (typeof r.peer !== 'string' || !this.peers.includes(r.peer)) return;
    if (r.t === 'signal') {
      const signal = parseMediaSignal(r.signal);
      if (signal) this.callbacks.signal(r.peer, signal);
    } else if (r.t === 'packet' && r.bytes instanceof Uint8Array && r.bytes.length > 0 && r.bytes.length <= 1200) {
      this.callbacks.packet(r.peer, r.bytes);
    } else if (r.t === 'status' && ['off', 'connecting', 'connected', 'failed'].includes(String(r.status))) {
      if (this.status(r.peer) === r.status) return;
      this.states.set(r.peer, r.status as MediaStatus);
      this.callbacks.changed();
    }
  };

  private destroy(): void {
    const win = this.win;
    this.win = null;
    this.ready = false;
    this.states.clear();
    this.pendingSignals.clear();
    if (win && !win.isDestroyed()) win.destroy();
  }
}
