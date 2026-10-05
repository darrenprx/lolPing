import { EventEmitter } from 'node:events';
import { eventMessage, type NostrEvent } from './nostrEvent';
import { RelayConnection, type RelayState, type SocketFactory } from './relayConnection';
import type { TransportStatus } from './transport';

export interface RelayPoolOptions {
  urls: readonly string[];
  topic: string;
  pubkey: string;
  socket?: SocketFactory;
  random?: () => number;
}

/** How long a join waits for any relay to send our own events back before calling the internet unavailable. */
const UNAVAILABLE_MS = 15_000;
/** Each event arrives once per relay; remembering this many ids drops the copies. */
const DEDUPE = 512;
/** Incoming events per second from all relays together, after duplicates are dropped. */
const BUDGET_PER_SECOND = 200;

/**
 * Every pinned relay at once: publishes to each one that is live and merges what they deliver. Status is `ok` while
 * at least one relay sends our own events back. Events: 'event' (NostrEvent, deduplicated and within budget),
 * 'status' (TransportStatus), 'linkUp' (url), 'ok' (eventId, ok).
 */
export class RelayPool extends EventEmitter {
  status: TransportStatus = 'off';
  private readonly conns: RelayConnection[];
  /** Relays that went live at least once, and relays that failed before ever going live. */
  private readonly everLive = new Set<RelayConnection>();
  private readonly failed = new Set<RelayConnection>();
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private readonly ring: string[] = [];
  private windowStart = 0;
  private windowCount = 0;

  constructor(opts: RelayPoolOptions) {
    super();
    this.conns = opts.urls.map((url) => {
      const c = new RelayConnection({ url, topic: opts.topic, pubkey: opts.pubkey, socket: opts.socket, random: opts.random });
      c.on('event', (e: NostrEvent) => this.onEvent(e));
      c.on('echo', () => this.refresh());
      c.on('state', (s: RelayState) => {
        if ((s === 'down' || s === 'retired') && !this.everLive.has(c)) this.failed.add(c);
        this.refresh();
      });
      c.on('live', () => {
        this.everLive.add(c);
        this.emit('linkUp', url);
      });
      c.on('ok', (id: string, ok: boolean) => this.emit('ok', id, ok));
      return c;
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.setStatus('starting');
    this.timer = setTimeout(() => {
      if (this.status === 'starting') this.setStatus('unavailable');
    }, UNAVAILABLE_MS);
    for (const c of this.conns) c.start();
  }

  /** Closes every relay; nothing is emitted afterwards. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const c of this.conns) c.stop();
    this.status = 'off';
  }

  /** How many relays it went to. */
  publish(e: NostrEvent): number {
    const json = eventMessage(e);
    return this.conns.filter((c) => c.publish(json)).length;
  }

  /** For a stop that waits on a bye: relays that aren't live close now, none reconnects. How many are still open. */
  drain(): number {
    for (const c of this.conns) c.drain();
    return this.conns.filter((c) => c.state === 'live').length;
  }

  /** The Retry button: every relay that is down or retired reconnects now; ones already connecting are left alone. */
  retryNow(): void {
    for (const c of this.conns) c.reconnectNow(true);
  }

  /** After sleep: sockets are likely dead, so every relay still in use reconnects now. */
  wake(): void {
    for (const c of this.conns) c.reconnectNow(false);
  }

  private onEvent(e: NostrEvent): void {
    if (this.stopped || this.seen.has(e.id)) return;
    this.seen.add(e.id);
    this.ring.push(e.id);
    if (this.ring.length > DEDUPE) this.seen.delete(this.ring.shift()!);
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (++this.windowCount > BUDGET_PER_SECOND) return;
    this.emit('event', e);
  }

  private refresh(): void {
    if (this.stopped) return;
    if (this.conns.some((c) => c.healthy)) this.setStatus('ok');
    else if (this.status === 'ok') this.setStatus('unavailable');
    // Every relay failed before ever connecting (no internet at all): no point waiting out the 15 s.
    else if (this.status === 'starting' && this.failed.size === this.conns.length) this.setStatus('unavailable');
  }

  private setStatus(s: TransportStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit('status', s);
  }
}
