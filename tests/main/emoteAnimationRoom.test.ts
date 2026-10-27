import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmoteAnimationTransfer } from '../../src/main/emoteAnimationTransfer';
import { open, type RoomKeys } from '../../src/main/roomCrypto';
import { RoomManager } from '../../src/main/roomManager';
import { makeRoomCode } from '../../src/shared/roomCode';
import { decodeSigned, type RoomMessage } from '../../src/shared/roomProtocol';
import { FakeTransport } from './fixtures/fakeTransport';

const KEYS: RoomKeys = { msgKey: Buffer.alloc(32, 7), relayTopic: 'animation-test' };
const CODE = makeRoomCode(new Uint8Array(9).fill(1));
const HASH = 'a'.repeat(32);
interface Side {
  room: RoomManager;
  transfer: EmoteAnimationTransfer;
  transport: FakeTransport;
  bytes: Uint8Array;
  cache: Map<string, Uint8Array>;
  cursor: number;
  messages: RoomMessage[];
}
const sides: Side[] = [];

function side(seed: number, kind: 'lan' | 'internet' = 'lan', capable = true): Side {
  const transport = new FakeTransport(kind);
  const bytes = new Uint8Array(600_000).fill(seed);
  bytes.set([...Buffer.from('GIF89a'), 100, 0, 80, 0, 0, 0, 0, 0x3b]);
  const cache = new Map<string, Uint8Array>();
  const room = new RoomManager({
    transports: [transport], now: Date.now, randomBytes: (n) => new Uint8Array(n).fill(seed),
    deriveKeys: async () => KEYS, appVersion: '0.5.3',
    profile: () => ({ name: `P${seed}`, color: 1, rgb: null, limit: 5, nf: [] }),
    resolveTarget: () => ({ displayId: 1, width: 1000, height: 500 }),
    announceEmotes: () => seed === 1 ? [HASH] : [], animationSync: () => capable,
  });
  const transfer = new EmoteAnimationTransfer({
    now: Date.now, enabled: () => true, canPeer: (p) => room.canSyncAnimation(p),
    announced: () => seed === 1 ? [HASH] : [], animation: async () => bytes,
    have: (h) => cache.has(h), put: async (h, b) => { cache.set(h, b); return true; }, touch: () => undefined,
    send: (p, body) => room.sendToLan(p, body),
  });
  room.on('animationEmotes', (p: string, h: string[]) => transfer.announced(p, h));
  room.on('memberGone', (p: string) => transfer.memberGone(p));
  room.on('anim-want', (m: Parameters<EmoteAnimationTransfer['onWant']>[0]) => { void transfer.onWant(m); });
  room.on('anim-info', (m: Parameters<EmoteAnimationTransfer['onInfo']>[0]) => transfer.onInfo(m));
  room.on('anim-chunk', (m: Parameters<EmoteAnimationTransfer['onChunk']>[0]) => transfer.onChunk(m));
  const s = { room, transfer, transport, bytes, cache, cursor: 0, messages: [] as RoomMessage[] };
  sides.push(s);
  return s;
}

/** Fake packet delivery retains the real room sealing, signatures, validation, routing and timers. */
function pump(a: ReturnType<typeof side>, b: ReturnType<typeof side>): void {
  for (let pass = 0; pass < 20; pass++) {
    let delivered = 0;
    for (const [from, to] of [[a, b], [b, a]]) {
      const pending = from.transport.sent.slice(from.cursor);
      from.cursor += pending.length;
      for (const s of pending) {
        const plain = open(KEYS.msgKey, s.packet);
        const m = plain && decodeSigned(plain)?.msg;
        if (m) from.messages.push(m);
        to.transport.deliver(`lan:${from.room.self}`, s.packet);
        delivered++;
      }
    }
    if (delivered === 0) return;
  }
  throw new Error('packet loop');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of sides.splice(0)) { s.transfer.stop(); s.room.quit(); }
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('LAN animation room integration', () => {
  it('prefetches an original above 512 KiB through signed room packets while pings still arrive', async () => {
    const a = side(1);
    const b = side(2);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    pump(a, b);
    const pings: unknown[] = [];
    b.room.on('remotePing', (p: unknown) => pings.push(p));
    await vi.advanceTimersByTimeAsync(100);
    pump(a, b);
    a.room.sendPing('danger', { d: 1, x: 0.5, y: 0.5 });
    pump(a, b);
    expect(pings).toHaveLength(1);
    expect(b.cache.size).toBe(0);
    for (let ticks = 0; ticks < 400 && b.cache.size === 0; ticks++) {
      await vi.advanceTimersByTimeAsync(100);
      pump(a, b);
    }
    await Promise.resolve();
    const received = [...b.cache.values()][0];
    expect(received && Buffer.from(received).equals(Buffer.from(a.bytes))).toBe(true);
    expect(b.transfer.url(a.room.self, HASH)).toMatch(/^lolping:\/\/emotes\/[0-9a-f]{64}\.anim$/);
    expect(a.transport.sent.every((s) => s.packet.length <= 1200)).toBe(true);
    expect(b.transport.sent.every((s) => s.packet.length <= 1200)).toBe(true);
  });

  it.each(['old peer', 'internet'])('keeps the static protocol and sends no animation packets with %s', async (mode) => {
    const a = side(1, mode === 'internet' ? 'internet' : 'lan');
    const b = side(2, mode === 'internet' ? 'internet' : 'lan', mode !== 'old peer');
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    for (let ticks = 0; ticks < 50; ticks++) {
      pump(a, b);
      await vi.advanceTimersByTimeAsync(100);
    }
    pump(a, b);
    expect([...a.messages, ...b.messages].some((m) => m.t.startsWith('anim-'))).toBe(false);
    expect(a.room.canSyncAnimation(b.room.self)).toBe(false);
    expect(b.room.canSyncAnimation(a.room.self)).toBe(false);
    expect(b.cache.size).toBe(0);
    expect(b.transfer.url(a.room.self, HASH)).toBeNull();
  });
});
