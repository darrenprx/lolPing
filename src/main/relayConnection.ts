import { EventEmitter } from 'node:events';
import { parseRelayMessage, reqMessage, ROOM_EVENT_KIND, type NostrEvent } from './nostrEvent';

/** connecting → live ⇄ cooling; down waits to reconnect; retired stays out for this room session. */
export type RelayState = 'connecting' | 'live' | 'cooling' | 'down' | 'retired';

/** The slice of the WebSocket API in use; Node's global WebSocket satisfies it. */
export interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface RelayConnectionOptions {
  url: string;
  /** The room's relay topic: the only events we subscribe to. */
  topic: string;
  /** Ours: events signed with it are our own coming back, which proves the relay delivers. */
  pubkey: string;
  socket?: SocketFactory;
  random?: () => number;
}

const SUB_ID = 'lolping';
/** The replay guard's window: a relay that wrongly stored older events can't send them back. */
const SINCE_S = 600;
const CONNECT_MS = 10_000;
/** Presence goes out every 10 s, so a relay that sends none of ours back for this long isn't delivering. */
const HEALTH_MS = 25_000;
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_RESET_MS = 60_000;
const JITTER = 0.2;
const COOL_MS = 30_000;
/** Far above what one room's subscription ever gets: a relay past these is attacking us, not talking to us. */
const MAX_MESSAGE = 64 * 1024;
const MAX_PER_SECOND = 400;
const RETIRE_PREFIXES = ['blocked:', 'restricted:', 'auth-required:', 'pow:', 'invalid:'];

const defaultSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/**
 * One relay: keeps a subscription to the room's topic open, publishes while live, and judges the relay by whether
 * our own events come back. Each state owns exactly one timer (connect deadline, health deadline, cool-down or
 * backoff), so every transition starts by clearing it. Events: 'event' (NostrEvent from someone else), 'echo',
 * 'live', 'ok' (eventId, ok, message), 'state' (RelayState).
 */
export class RelayConnection extends EventEmitter {
  readonly url: string;
  state: RelayState = 'down';
  private sock: SocketLike | null = null;
  private stopped = true;
  /** Waiting for a bye's OK before stopping: nothing reconnects any more. */
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private echoed = false;
  private healthySince: number | null = null;
  private closedOnce = false;
  private windowStart = 0;
  private windowCount = 0;
  private readonly socket: SocketFactory;
  private readonly random: () => number;

  constructor(private readonly opts: RelayConnectionOptions) {
    super();
    this.url = opts.url;
    this.socket = opts.socket ?? defaultSocket;
    this.random = opts.random ?? Math.random;
  }

  get healthy(): boolean {
    return (this.state === 'live' || this.state === 'cooling') && this.echoed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.draining = false;
    this.connect();
  }

  /** For good: closes the socket, and nothing is emitted afterwards. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.closeSocket();
    this.state = 'down';
  }

  /** False when the relay isn't live, so nothing went out. */
  publish(json: string): boolean {
    if (this.state !== 'live' || !this.sock) return false;
    try {
      this.sock.send(json);
      return true;
    } catch {
      return false; // closing under us: the close handler takes it from here
    }
  }

  /**
   * Skips any backoff. `revive` (Retry) reconnects only a relay that is down or retired, so pressing it again never
   * undoes a connection in progress. Otherwise (wake from sleep) every relay but a retired one reconnects: its socket
   * may have died while we slept.
   */
  reconnectNow(revive: boolean): void {
    if (this.stopped || this.draining) return;
    if (revive ? this.state !== 'down' && this.state !== 'retired' : this.state === 'retired') return;
    this.attempts = 0;
    this.connect();
  }

  /** A stop that waits for a bye: a relay that isn't live didn't get it and closes now; none reconnects any more. */
  drain(): void {
    if (this.stopped) return;
    if (this.state !== 'live') return this.stop();
    this.draining = true;
  }

  private connect(): void {
    this.clearTimer();
    this.closeSocket();
    this.echoed = false;
    this.healthySince = null;
    this.closedOnce = false;
    let sock: SocketLike;
    try {
      sock = this.socket(this.url);
    } catch {
      this.retire(); // a malformed URL never gets better
      return;
    }
    this.sock = sock;
    sock.onopen = () => {
      if (sock !== this.sock) return;
      this.subscribe();
      this.setState('live');
      this.armHealth();
      if (!this.stopped) this.emit('live');
    };
    sock.onmessage = (ev) => {
      if (sock === this.sock) this.onMessage(ev.data);
    };
    sock.onclose = sock.onerror = () => {
      if (sock === this.sock) this.down();
    };
    this.setState('connecting');
    this.timer = setTimeout(() => this.down(), CONNECT_MS);
  }

  private subscribe(): void {
    this.sock?.send(reqMessage(SUB_ID, this.opts.topic, Math.floor(Date.now() / 1000) - SINCE_S));
  }

  private onMessage(data: unknown): void {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (++this.windowCount > MAX_PER_SECOND) return this.retire();
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return this.retire(); // Nostr is text only
    const m = parseRelayMessage(data);
    if (!m) return;
    if (m.type === 'EVENT') {
      const e = m.event;
      if (m.subId !== SUB_ID || e.kind !== ROOM_EVENT_KIND || !e.tags.some((t) => t[0] === 'x' && t[1] === this.opts.topic)) return;
      if (e.pubkey === this.opts.pubkey) this.onEcho();
      else this.emit('event', e satisfies NostrEvent);
    } else if (m.type === 'OK') {
      this.emit('ok', m.eventId, m.ok, m.message);
      if (m.ok) return;
      if (m.message.startsWith('rate-limited:')) this.cool();
      else if (RETIRE_PREFIXES.some((p) => m.message.startsWith(p))) this.retire();
    } else if (m.type === 'CLOSED' && m.subId === SUB_ID) {
      if (this.closedOnce) return this.retire();
      this.closedOnce = true;
      this.subscribe();
    }
  }

  private onEcho(): void {
    if (this.state !== 'live' && this.state !== 'cooling') return;
    if (!this.echoed) {
      this.echoed = true;
      this.healthySince = Date.now();
    }
    this.emit('echo');
    if (this.state === 'live') this.armHealth();
  }

  /** Rate-limited: publish nothing for a while, and don't hold the missing echoes against it. */
  private cool(): void {
    if (this.state !== 'live') return;
    if (this.draining) return this.stop(); // it won't take the bye now
    this.clearTimer();
    this.setState('cooling');
    this.timer = setTimeout(() => {
      this.setState('live');
      this.armHealth();
    }, COOL_MS);
  }

  private armHealth(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.down(), HEALTH_MS);
  }

  private down(): void {
    if (this.stopped || this.state === 'retired') return;
    if (this.draining) return this.stop();
    if (this.healthySince !== null && Date.now() - this.healthySince >= BACKOFF_RESET_MS) this.attempts = 0;
    this.clearTimer();
    this.closeSocket();
    this.echoed = false;
    this.healthySince = null;
    this.setState('down');
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts++);
    this.timer = setTimeout(() => this.connect(), delay * (1 + (this.random() * 2 - 1) * JITTER));
  }

  private retire(): void {
    this.clearTimer();
    this.closeSocket();
    this.echoed = false;
    this.setState('retired');
  }

  private closeSocket(): void {
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.close();
    } catch {
      // already closed
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setState(s: RelayState): void {
    if (s === this.state) return;
    this.state = s;
    if (!this.stopped) this.emit('state', s);
  }
}
