import { screen } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Lang } from '../shared/i18n';
import { jpegSize } from '../shared/jpegSize';
import type { RoomShotMessage } from '../shared/roomProtocol';
import type { Settings } from '../shared/settings';
import { featureOn } from '../shared/features';
import { resolveTarget } from './displayNumbers';
import { contextHelperPath, settingsDir, HIDDEN_TEST_RUN } from './paths';
import type { OverlayManager } from './overlayManager';
import type { MemberTag, RoomManager } from './roomManager';
import { RoomShotCapture } from './roomShotCapture';
import { RoomShotController } from './roomShotController';
import { ShotTransfer } from './shotTransfer';
import { ShotWindows } from './shotWindows';
import { ContextClient } from './teammate/contextClient';
import { StaleWatcher } from './teammate/staleWatcher';

/** Windows runtime for local room attachments; independent of AI profiles, keys and history. */
export class RoomShotsRuntime {
  readonly windows: ShotWindows;
  readonly controller: RoomShotController;
  private readonly context = new ContextClient({ command: contextHelperPath() });
  private readonly capture: RoomShotCapture;
  private readonly transfer: ShotTransfer;
  private readonly watch: StaleWatcher;
  private readonly ticker: NodeJS.Timeout;
  private readonly tags = new Map<string, MemberTag>();
  private readonly notified = new Set<string>();
  private session = '';
  private lastSeconds = 0;
  private previous: Settings['roomShots'];
  private stopped = false;
  private cleanup: Promise<void> = Promise.resolve();
  private resetting = false;

  constructor(private readonly deps: {
    room: RoomManager; overlays: OverlayManager; settings(): Settings; enabled(): boolean; lang(): Lang;
    lease(): () => void; helperWatch(on: boolean): void; cooldown(ms: number, displayId: number): void; statusChanged(): void;
  }) {
    this.previous = { ...deps.settings().roomShots };
    this.windows = new ShotWindows({ hidden: HIDDEN_TEST_RUN, now: Date.now, settings: () => deps.settings().roomShots, lang: deps.lang,
      target: (d) => {
        const target = resolveTarget(deps.overlays.numbered(), d);
        return target ? { displayId: target.id, width: target.bounds.width, height: target.bounds.height } : null;
      },
    });
    this.capture = new RoomShotCapture(this.context, join(settingsDir(), 'room-shot-temp'), deps.lease);
    void this.capture.clean();
    this.transfer = new ShotTransfer({ now: Date.now, self: () => deps.room.self,
      peers: () => deps.room.shotPeers(), send: (peer, body) => deps.room.sendShot(peer, body),
      metadata: (peer, meta) => {
        this.windows.update(peer, this.tags.get(peer)?.name ?? '', { meta, data: null,
          status: meta.status === 'ready' ? 'loading' : meta.status });
      },
      completed: (peer, meta, data) => {
        const size = jpegSize(data);
        const ok = size?.w === meta.w && size.h === meta.h;
        this.windows.update(peer, this.tags.get(peer)?.name ?? '', { meta,
          data: ok ? `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}` : null, status: ok ? 'ready' : 'capture' });
      },
      failed: (peer, meta) => this.windows.update(peer, this.tags.get(peer)?.name ?? '', { meta, data: null, status: 'timeout' }),
    });
    this.watch = new StaleWatcher({
      front: async (signal) => { await this.cleanup; return this.context.front(signal); },
      busy: () => this.context.busy, ownPid: process.pid,
      helper: deps.helperWatch,
      own: (at) => { const dip = deps.overlays.toDip(at); return dip ? this.windows.contains(dip) : false; },
      stale: () => this.controller.invalidate(),
      every: (ms, fn) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); },
    });
    this.controller = new RoomShotController({ now: () => performance.now(), id: () => randomBytes(8).toString('hex'),
      settings: () => deps.settings().roomShots,
      source: (id) => {
        const display = screen.getAllDisplays().find((d) => d.id === id);
        const number = deps.overlays.numbered().findIndex((d) => d.id === id) + 1;
        if (!display || !number) return null;
        const b = display.bounds, p = screen.dipToScreenRect(null, b);
        return { displayId: id, number,
          bounds: { x: b.x, y: b.y, w: b.width, h: b.height }, physical: { x: p.x, y: p.y, w: p.width, h: p.height }, scale: display.scaleFactor };
      },
      canCapture: () => this.active() && deps.settings().roomShots.enabled && deps.room.shotPeers().length > 0,
      capture: async (crop, signal) => { await this.cleanup; return this.capture.capture(crop, signal); },
      publish: (meta, data) => this.transfer.publish(meta, data),
      cooldown: deps.cooldown, watch: (on) => { if (on) this.watch.start(''); else this.watch.stop(); },
    });
    deps.overlays.setMarkerAdmission((p) => this.controller.admit(p));
    this.ticker = setInterval(() => this.tick(), 25);
    deps.room.on('shot', this.onShot);
    deps.room.on('memberGone', this.onGone);
    deps.room.on('state', this.onState);
    deps.overlays.on('displays', this.onDisplays);
  }

  get remaining(): number { return this.controller.gate.remaining(); }
  helperReady(): void { this.watch.helperReady(); }
  scroll(at: { x: number; y: number }): void { this.watch.scroll(at); }

  remote(p: { peer?: string; batch?: string }): boolean {
    if (!p.peer || !p.batch) return false;
    const key = `${p.peer}:${p.batch}`;
    const silent = this.notified.has(key);
    this.notified.add(key);
    while (this.notified.size > 128) { const first = this.notified.values().next().value; if (first) this.notified.delete(first); }
    return silent;
  }

  reconfigure(): void {
    const s = this.deps.settings().roomShots;
    if (!s.enabled && this.previous.enabled) { this.controller.invalidate(); this.transfer.cancelSending(); }
    if (!s.receive && this.previous.receive) { this.transfer.cancelReceiving(); this.windows.clear(); }
    this.previous = { ...s };
    this.windows.reconfigure();
    this.onState();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.ticker);
    this.deps.room.off('shot', this.onShot);
    this.deps.room.off('memberGone', this.onGone);
    this.deps.room.off('state', this.onState);
    this.deps.overlays.off('displays', this.onDisplays);
    this.controller.invalidate(); this.transfer.clear(); this.windows.destroy();
    await this.cleanup;
    await this.context.stop();
    await this.capture.clean();
  }

  private active(): boolean {
    return this.deps.enabled() && featureOn(this.deps.settings(), 'rooms')
      && !this.deps.settings().roomMuted && this.deps.room.state().phase === 'active';
  }

  private tick(): void {
    this.controller.tick();
    if (this.active()) this.transfer.tick();
    this.windows.tick();
    const seconds = Math.ceil(this.remaining / 1000);
    if (seconds !== this.lastSeconds) { this.lastSeconds = seconds; this.deps.statusChanged(); }
  }

  private readonly onShot = (msg: RoomShotMessage, tag: MemberTag): void => {
    if (!this.active()) return;
    if (msg.t !== 'shotWant' && !this.deps.settings().roomShots.receive) return;
    this.tags.set(msg.peer, tag);
    this.transfer.receive(msg.peer, msg);
  };
  private readonly onGone = (peer: string): void => {
    this.tags.delete(peer); this.transfer.forget(peer); this.windows.forget(peer);
    for (const key of this.notified) if (key.startsWith(`${peer}:`)) this.notified.delete(key);
  };
  private readonly onDisplays = (): void => { this.controller.invalidate(); this.windows.reconfigure(); };
  private readonly onState = (): void => {
    if (!this.active() || this.session !== this.deps.room.self) {
      this.controller.invalidate(); this.transfer.clear(); this.windows.clear(); this.tags.clear(); this.notified.clear();
      if (!this.resetting) {
        this.resetting = true;
        this.cleanup = this.context.stop().then(() => this.capture.clean()).finally(() => { this.resetting = false; });
      }
    }
    this.session = this.deps.room.self;
    const live = this.deps.room.state().members.filter((m) => !m.self);
    for (const m of live) if (m.muted || m.status !== 'on') this.onGone(m.peer);
  };
}
