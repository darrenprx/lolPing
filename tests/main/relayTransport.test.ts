import { schnorr } from '@noble/secp256k1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeKeyPair, signEvent, type NostrEvent } from '../../src/main/nostrEvent';
import type { RoomKeys } from '../../src/main/roomCrypto';
import { RelayTransport } from '../../src/main/relayTransport';
import { RoomManager } from '../../src/main/roomManager';
import type { TransportStatus } from '../../src/main/transport';
import { formatRoomCode, makeRoomCode } from '../../src/shared/roomCode';
import { fakeSockets, type FakeSocket } from './fixtures/fakeSocket';

const KEYS: RoomKeys = { msgKey: Buffer.alloc(32, 1), relayTopic: 'cd'.repeat(32) };
const other = makeKeyPair();
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

let sockets: FakeSocket[];
let relay: RelayTransport;
let packets: [string, Buffer][];

const last = (): FakeSocket => sockets[sockets.length - 1];
const published = (s: FakeSocket): NostrEvent[] =>
  s.messages().filter((m) => m[0] === 'EVENT').map((m) => m[1] as NostrEvent);
const theirs = (content: string): NostrEvent =>
  signEvent(other, 24747, [['x', KEYS.relayTopic]], content, Math.floor(Date.now() / 1000));
/** Resolves to how long whenClosed() took, in fake ms. */
async function closeTime(during: () => void = () => undefined): Promise<number> {
  const start = Date.now();
  let at = -1;
  void relay.whenClosed().then(() => (at = Date.now() - start));
  during();
  for (let i = 0; i < 100 && at < 0; i++) await vi.advanceTimersByTimeAsync(10);
  return at;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_780_000_000_000 });
  const f = fakeSockets();
  sockets = f.sockets;
  relay = new RelayTransport({ urls: ['wss://a.test'], socket: f.factory, random: () => 0.5 });
  packets = [];
  relay.on('packet', (peer: string, data: Buffer) => packets.push([peer, data]));
});

afterEach(() => {
  relay.stop();
  vi.useRealTimers();
});

describe('RelayTransport', () => {
  it('is a shared internet transport', () => {
    expect(relay.kind).toBe('internet');
    expect(relay.shared).toBe(true);
    expect(relay.status).toBe('off');
  });

  it('wraps a packet as a kind 24747 event with our topic, base64 content and a valid signature', () => {
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([1, 2, 3]));
    const [e] = published(last());
    expect(e).toMatchObject({ kind: 24747, tags: [['x', KEYS.relayTopic]], content: 'AQID', created_at: 1_780_000_000 });
    expect(schnorr.verify(bytes(e.sig), bytes(e.id), bytes(e.pubkey))).toBe(true);
  });

  it('sendTo is a broadcast', () => {
    relay.start(KEYS);
    last().open();
    relay.sendTo('net:whoever', Uint8Array.from([9]));
    expect(published(last()).map((e) => e.content)).toEqual(['CQ==']);
  });

  it("emits packet(net:<pubkey>, bytes) for other members' events", () => {
    relay.start(KEYS);
    last().open();
    last().receive(['EVENT', 'lolping', theirs('AQID')]);
    expect(packets).toEqual([[`net:${other.pubkey}`, Buffer.from([1, 2, 3])]]);
  });

  it("drops content over 1600 characters or that isn't base64", () => {
    relay.start(KEYS);
    last().open();
    last().receive(['EVENT', 'lolping', theirs('A'.repeat(1604))]);
    last().receive(['EVENT', 'lolping', theirs('!!!!')]);
    last().receive(['EVENT', 'lolping', theirs('AQI')]);
    expect(packets).toEqual([]);
  });

  it('uses a new key pair on every start', () => {
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([1]));
    const first = published(last())[0].pubkey;
    relay.stop();
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([1]));
    expect(published(last())[0].pubkey).not.toBe(first);
  });

  it("stop waits for the bye's OK", async () => {
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([7]));
    const bye = published(last())[0];
    const s = last();
    relay.stop();
    expect(relay.status).toBe('off');
    const took = await closeTime(() => setTimeout(() => s.receive(['OK', bye.id, true, '']), 100));
    expect(took).toBe(100);
    expect(s.closed).toBe(true);
  });

  it('stop waits at most 500 ms', async () => {
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([7]));
    relay.stop();
    expect(await closeTime()).toBe(500);
  });

  it('stop while connecting resolves whenClosed at once', async () => {
    relay.start(KEYS);
    relay.broadcast(Uint8Array.from([7])); // no relay is live: it went nowhere
    relay.stop();
    expect(await closeTime()).toBe(0);
  });

  it('packets from a stopped session are never emitted', () => {
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([7]));
    const old = last();
    relay.stop(); // still draining the bye
    relay.start(KEYS);
    old.receive(['EVENT', 'lolping', theirs('AQID')]);
    expect(packets).toEqual([]);
  });

  it('forwards status and linkUp from the pool', () => {
    const statuses: TransportStatus[] = [];
    const linkUp = vi.fn();
    relay.on('status', (s: TransportStatus) => statuses.push(s));
    relay.on('linkUp', linkUp);
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([1]));
    const mine = published(last())[0];
    last().receive(['EVENT', 'lolping', mine]);
    relay.stop();
    expect(statuses).toEqual(['starting', 'ok', 'off']);
    expect(linkUp).toHaveBeenCalledTimes(1);
  });

  it('wake reconnects a live relay; retryNow only reconnects one that is down', () => {
    relay.start(KEYS);
    last().open();
    relay.wake();
    expect(sockets).toHaveLength(2);
    last().open();
    relay.retryNow();
    expect(sockets).toHaveLength(2);
    last().drop();
    relay.retryNow();
    expect(sockets).toHaveLength(3);
  });

  it('stop after the last event was acknowledged closes at once', async () => {
    relay.start(KEYS);
    last().open();
    relay.broadcast(Uint8Array.from([7]));
    last().receive(['OK', published(last())[0].id, true, '']);
    relay.stop();
    expect(await closeTime()).toBe(0);
    expect(last().closed).toBe(true);
  });

  it('while draining a bye, closes relays that are not live at once and never reconnects one', () => {
    const f = fakeSockets();
    const two = new RelayTransport({ urls: ['wss://a.test', 'wss://b.test', 'wss://c.test'], socket: f.factory, random: () => 0.5 });
    two.start(KEYS);
    const [a, b, c] = f.sockets;
    a.open();
    b.open();
    b.drop(); // b waits out a 2 s backoff; c is still connecting
    two.broadcast(Uint8Array.from([7]));
    two.stop();
    expect(c.closed).toBe(true);
    expect(a.closed).toBe(false); // live: kept for the bye's OK
    vi.advanceTimersByTime(3000);
    expect(f.sockets).toHaveLength(3);
    expect(a.closed).toBe(true);
  });
});

describe('RelayTransport under RoomManager', () => {
  it('flipping internet off and on leaves one open socket per relay', async () => {
    const f = fakeSockets();
    const urls = ['wss://a.test', 'wss://b.test'];
    const net = new RelayTransport({ urls, socket: f.factory, random: () => 0.5 });
    const room = new RoomManager({
      transports: [net], now: () => Date.now(), randomBytes: (n) => new Uint8Array(n).fill(0x12),
      deriveKeys: async () => KEYS, appVersion: '0.4.0', profile: () => ({ name: 'Me', color: 1, limit: 5 }),
      resolveTarget: () => null,
    });
    /** A relay that answers OK to everything it was sent. */
    const ackAll = (): void => {
      for (const s of f.sockets) if (!s.closed) for (const e of published(s)) s.receive(['OK', e.id, true, '']);
    };
    const open = (url: string): FakeSocket[] => f.sockets.filter((s) => s.url === url && !s.closed);
    await room.join(formatRoomCode(makeRoomCode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))));
    f.sockets.forEach((s) => s.open());
    await vi.advanceTimersByTimeAsync(1000);
    ackAll();
    room.setInternetAllowed(false);
    room.setInternetAllowed(true);
    f.sockets.filter((s) => s.readyState === 0).forEach((s) => s.open());
    for (const u of urls) expect(open(u)).toHaveLength(1);
    room.setInternetAllowed(false);
    await vi.advanceTimersByTimeAsync(600);
    for (const u of urls) expect(open(u)).toHaveLength(0);
    room.quit();
  });
});
