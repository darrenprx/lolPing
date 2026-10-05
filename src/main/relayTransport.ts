import { EventEmitter } from 'node:events';
import { makeKeyPair, ROOM_EVENT_KIND, signEvent, type KeyPair, type NostrEvent } from './nostrEvent';
import type { SocketFactory } from './relayConnection';
import { RelayPool } from './relayPool';
import { RELAYS } from './relays';
import type { RoomKeys } from './roomCrypto';
import type { PeerKey, Transport, TransportStatus } from './transport';

export interface RelayTransportOptions {
  urls?: readonly string[];
  socket?: SocketFactory;
  random?: () => number;
}

/** A sealed packet (≤ 1200 bytes) in base64. */
const MAX_CONTENT = 1600;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Longest a stop waits for the relays to take the bye RoomManager sent just before. */
const DRAIN_MS = 500;

/**
 * Room packets over public Nostr relays: each packet is one ephemeral event on the room's topic, signed with a key
 * made fresh on every join. One publish reaches every member, so this transport is shared. Members leave by bye or
 * timeout; relays have no per-peer connections, so there is no 'peerGone'.
 */
export class RelayTransport extends EventEmitter implements Transport {
  readonly kind = 'internet';
  readonly shared = true;
  status: TransportStatus = 'off';
  private pool: RelayPool | null = null;
  private pair: KeyPair | null = null;
  private topic = '';
  /** The id of the last event that reached a relay and isn't acknowledged yet: the bye a stop waits for. */
  private lastSent: string | null = null;
  private closing: Promise<void> = Promise.resolve();
  private readonly urls: readonly string[];

  constructor(private readonly opts: RelayTransportOptions = {}) {
    super();
    this.urls = opts.urls ?? RELAYS;
  }

  start(keys: RoomKeys): void {
    if (this.pool) return;
    const pair = makeKeyPair();
    const pool = new RelayPool({ urls: this.urls, topic: keys.relayTopic, pubkey: pair.pubkey, socket: this.opts.socket, random: this.opts.random });
    this.pool = pool;
    this.pair = pair;
    this.topic = keys.relayTopic;
    this.lastSent = null;
    // A stopped pool can still be draining its bye: nothing it hears belongs to the session after it.
    pool.on('event', (e: NostrEvent) => {
      if (this.pool === pool) this.onEvent(e);
    });
    pool.on('status', (s: TransportStatus) => {
      if (this.pool === pool) this.setStatus(s);
    });
    pool.on('linkUp', () => {
      if (this.pool === pool) this.emit('linkUp');
    });
    pool.on('ok', (id: string) => {
      if (this.pool === pool && id === this.lastSent) this.lastSent = null; // nothing left to wait for on stop
    });
    pool.start();
  }

  /** Sends nothing new; lets the bye already sent reach the relays, then closes. */
  stop(): void {
    const pool = this.pool;
    if (!pool) return;
    this.pool = this.pair = null;
    const pending = this.lastSent;
    this.lastSent = null;
    this.setStatus('off');
    const closed = new Promise<void>((resolve) => {
      // Relays that aren't live close at once and none reconnects: after a stop, no relay is contacted again.
      if (!pending || pool.drain() === 0) {
        pool.stop();
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        pool.off('ok', onOk);
        pool.stop();
        resolve();
      };
      const onOk = (id: string): void => {
        if (id === pending) finish();
      };
      const timer = setTimeout(finish, DRAIN_MS);
      pool.on('ok', onOk);
    });
    const previous = this.closing;
    this.closing = Promise.all([previous, closed]).then(() => undefined);
  }

  whenClosed(): Promise<void> {
    return this.closing;
  }

  /** Every member hears every event, so a packet for one is a packet for all. */
  sendTo(_peer: PeerKey, packet: Uint8Array): void {
    this.broadcast(packet);
  }

  broadcast(packet: Uint8Array): void {
    if (!this.pool || !this.pair) return;
    const content = Buffer.from(packet.buffer, packet.byteOffset, packet.length).toString('base64');
    const e = signEvent(this.pair, ROOM_EVENT_KIND, [['x', this.topic]], content, Math.floor(Date.now() / 1000));
    this.lastSent = this.pool.publish(e) > 0 ? e.id : null;
  }

  /** The Retry button. */
  retryNow(): void {
    this.pool?.retryNow();
  }

  /** After sleep. */
  wake(): void {
    this.pool?.wake();
  }

  private onEvent(e: NostrEvent): void {
    if (e.content.length > MAX_CONTENT || !BASE64.test(e.content)) return;
    this.emit('packet', `net:${e.pubkey}`, Buffer.from(e.content, 'base64'));
  }

  private setStatus(s: TransportStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit('status', s);
  }
}
