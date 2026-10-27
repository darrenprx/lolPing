import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmoteAnimationTransfer } from '../../src/main/emoteAnimationTransfer';
import { EmoteTransfer } from '../../src/main/emoteTransfer';
import { open, seal, type RoomKeys } from '../../src/main/roomCrypto';
import { RoomManager } from '../../src/main/roomManager';
import { makeRoomCode } from '../../src/shared/roomCode';
import { decodeSigned, encodeMessage } from '../../src/shared/roomProtocol';
import { FakeTransport } from './fixtures/fakeTransport';

const KEYS: RoomKeys = { msgKey: Buffer.alloc(32, 7), relayTopic: 'target-test' };
const CODE = makeRoomCode(new Uint8Array(9).fill(1));
const still = Buffer.alloc(3000, 7);
still.write('RIFF', 0); still.writeUInt32LE(still.length - 8, 4); still.write('WEBPVP8 ', 8);
still.writeUInt32LE(still.length - 20, 16); still.set([0x30, 1, 0, 0x9d, 1, 0x2a, 160, 0, 120, 0], 20);
const HASH = createHash('sha256').update(still).digest('hex').slice(0, 32);
interface Side {
  room: RoomManager;
  transport: FakeTransport;
  state: { hashes: string[]; media: boolean };
  cache: Map<string, Uint8Array>;
  animationCache: Map<string, Uint8Array>;
  original: Uint8Array;
  mediaPackets: { peer: string; bytes: Uint8Array }[];
  transfer: EmoteTransfer;
  animations: EmoteAnimationTransfer;
  received: { pings: number; emotes: number; text: number; votes: number };
  cursor: number;
  mediaCursor: number;
}
const sides: Side[] = [];

function side(seed: number, kind: 'lan' | 'internet', capable = true): Side {
  const transport = new FakeTransport(kind);
  const state = { hashes: [] as string[], media: true };
  const original = new Uint8Array(5 * 1024 * 1024).fill(seed);
  original.set([...Buffer.from('GIF89a'), 100, 0, 80, 0, 0, 0, 0, 0x3b]);
  const mediaPackets: { peer: string; bytes: Uint8Array }[] = [];
  const room = new RoomManager({
    transports: [transport], now: Date.now, randomBytes: (n) => new Uint8Array(n).fill(seed),
    deriveKeys: async () => KEYS, appVersion: '0.6.0',
    profile: () => ({ name: `P${seed}`, color: 1, rgb: null, limit: 20, nf: [] }),
    resolveTarget: () => ({ displayId: 1, width: 1000, height: 500 }),
    announceEmotes: () => state.hashes, animationSync: () => capable,
    internetAnimation: () => state.media && capable,
    media: { status: () => 'connected', send: (peer, bytes) => mediaPackets.push({ peer, bytes }) },
  });
  const cache = new Map<string, Uint8Array>();
  const animationCache = new Map<string, Uint8Array>();
  const transfer = new EmoteTransfer({
    now: Date.now, enabled: () => true, have: (h) => cache.has(h), still: () => still,
    announced: () => state.hashes, put: (h, bytes) => void cache.set(h, bytes),
    routeOf: (p) => room.transferRoute(p), canServe: (p) => room.canSendTo(p),
    broadcastAllowed: () => room.broadcastAllowed(), sendDirect: (p, body) => room.sendStill(p, body),
    sendToLan: (p, body) => room.sendToLan(p, body), broadcastShared: (body) => room.broadcastShared(body),
    spareSharedToken: (keep) => room.spareSharedToken(keep),
  });
  const animations = new EmoteAnimationTransfer({
    now: Date.now, enabled: () => true, canPeer: (p) => room.canSyncAnimation(p), announced: () => state.hashes,
    animation: async () => original, have: (h) => animationCache.has(h),
    put: async (h, bytes) => { animationCache.set(h, bytes); return true; }, touch: () => undefined,
    send: (p, body) => room.sendAnimation(p, body),
  });
  room.on('emotes', (p, hashes) => transfer.announced(p, hashes));
  room.on('want', (m) => transfer.onWant(m)); room.on('chunk', (m) => transfer.onChunk(m));
  room.on('animationEmotes', (p, hashes) => animations.announced(p, hashes));
  room.on('anim-want', (m) => { void animations.onWant(m); });
  room.on('anim-info', (m) => animations.onInfo(m)); room.on('anim-chunk', (m) => animations.onChunk(m));
  room.on('memberGone', (p) => { transfer.memberGone(p); animations.memberGone(p); });
  const received = { pings: 0, emotes: 0, text: 0, votes: 0 };
  room.on('remotePing', () => received.pings++); room.on('remoteEmote', () => received.emotes++);
  room.on('remoteText', () => received.text++); room.on('vote', () => received.votes++);
  const s = { room, transport, state, cache, animationCache, original, mediaPackets, transfer, animations, received, cursor: 0, mediaCursor: 0 };
  sides.push(s);
  return s;
}

/** Every shared packet also reaches the unselected third member. Only payload authentication can exclude it. */
function pump() {
  for (let pass = 0; pass < 30; pass++) {
    let count = 0;
    for (const from of sides) {
      for (const sent of from.transport.sent.slice(from.cursor)) {
        from.cursor++;
        for (const to of sides) if (to !== from && (sent.to === '*' || sent.to === fromKey(to))) {
          to.transport.deliver(fromKey(from), sent.packet);
        }
        count++;
      }
      for (const sent of from.mediaPackets.slice(from.mediaCursor)) {
        from.mediaCursor++;
        sides.find((s) => s.room.self === sent.peer)?.room.receiveMedia(from.room.self, sent.bytes);
        count++;
      }
    }
    if (!count) return;
  }
  throw new Error('packet loop');
}
const fromKey = (s: ReturnType<typeof side>) => `lan:${s.room.self}`;
async function advance(ms: number) {
  for (let at = 0; at < ms; at += 100) { await vi.advanceTimersByTimeAsync(100); pump(); }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of sides.splice(0)) { s.transfer.stop(); s.animations.stop(); s.room.quit(); }
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('room audience', () => {
  it('keeps legacy peers in everyone broadcasts but never falls back to shared selected content', async () => {
    const a = side(1, 'internet'); await a.room.join(CODE);
    const legacy = 'f'.repeat(16);
    a.transport.deliver('old-peer', seal(KEYS.msgKey, encodeMessage({
      t: 'presence', peer: legacy, seq: 1, ts: Date.now(), proto: 1, app: '0.5.1',
      name: 'Old peer', color: 1, status: 'on', em: [], nf: [],
    })));
    expect(a.room.state().members.find((m) => m.peer === legacy)?.direct).toBe(false);
    a.room.setAudience({ mode: 'selected', peers: [legacy] });
    expect(a.room.state().audience?.peers).toEqual([]);
    const start = a.transport.sent.length;
    a.room.sendPing('danger', { d: 1, x: 0.5, y: 0.5 });
    expect(a.transport.sent).toHaveLength(start);
    a.room.setAudience({ mode: 'all', peers: [] });
    a.room.sendPing('danger', { d: 1, x: 0.5, y: 0.5 });
    const packet = a.transport.sent.at(-1)?.packet;
    const plain = packet && open(KEYS.msgKey, packet);
    expect(plain && decodeSigned(plain)?.msg.t).toBe('ping');
  });

  it('resets recipients on rejoin and removes media peers when muted or disabled', async () => {
    const a = side(1, 'internet'); const b = side(2, 'internet');
    await Promise.all(sides.map((s) => s.room.join(CODE))); pump();
    expect(a.room.mediaPeers()).toEqual([b.room.self]);
    a.room.muteMember(b.room.self, true); expect(a.room.mediaPeers()).toEqual([]);
    a.room.muteMember(b.room.self, false); expect(a.room.mediaPeers()).toEqual([b.room.self]);
    a.room.setStatusFlags({ paused: true, roomMuted: false }); expect(a.room.mediaPeers()).toEqual([]);
    a.room.setStatusFlags({ paused: false, roomMuted: false });
    a.state.media = false; expect(a.room.mediaPeers()).toEqual([]);
    a.room.setAudience({ mode: 'self', peers: [] });
    a.room.leave(); await a.room.join(CODE);
    expect(a.room.state().audience).toEqual({ mode: 'all', peers: [] });
  });

  it('preserves a pending fragmented media offer when the audience changes', async () => {
    const a = side(1, 'internet'); const b = side(2, 'internet');
    await Promise.all(sides.map((s) => s.room.join(CODE))); pump();
    const signal = { id: 'a'.repeat(16), type: 'offer' as const,
      sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=x:' + 'x'.repeat(8000) + '\r\n' };
    const received: unknown[] = [];
    b.room.on('mediaSignal', (peer, value) => received.push({ peer, value }));
    a.room.sendMediaSignal(b.room.self, signal); pump();
    expect(received).toHaveLength(0);
    a.room.setAudience({ mode: 'self', peers: [] });
    await advance(5000);
    expect(received).toEqual([{ peer: a.room.self, value: signal }]);
  });

  it.each(['lan', 'internet'] as const)('only delivers selected content over %s and keeps votes room-wide', async (kind) => {
    const a = side(1, kind); const b = side(2, kind); const c = side(3, kind);
    await Promise.all(sides.map((s) => s.room.join(CODE))); pump();
    a.room.setAudience({ mode: 'selected', peers: [b.room.self] });
    a.state.hashes = [HASH]; a.room.profileChanged();
    a.room.sendPing('danger', { d: 1, x: 0.5, y: 0.5 });
    a.room.sendEmote('c:' + HASH, { d: 1, x: 0.5, y: 0.5 });
    a.room.sendText('private', { d: 1, x: 0.5, y: 0.5 });
    a.room.sendAlive(b.room.self, { d: 1, x: 0.5, y: 0.5 });
    a.room.sendVote({ id: 'abcdef12', kind: 'ready' });
    pump(); await advance(6000);
    expect(b.received).toEqual({ pings: 1, emotes: 1, text: 2, votes: 1 });
    expect(c.received).toEqual({ pings: 0, emotes: 0, text: 0, votes: 1 });
    expect(Buffer.from(b.cache.get(HASH) ?? []).equals(still)).toBe(true); expect(c.cache.size).toBe(0);
    const visible = a.transport.sent.flatMap((s) => {
      const plain = open(KEYS.msgKey, s.packet); const msg = plain && decodeSigned(plain)?.msg; return msg ? [msg] : [];
    });
    expect(visible.some((m) => m.t === 'chunk' || m.t === 'emote' || m.t === 'text' || m.t === 'ping')).toBe(false);
    expect(a.transport.sent.every((s) => s.packet.length <= 1200)).toBe(true);
    a.room.setAudience({ mode: 'self', peers: [] });
    a.room.sendPing('danger', { d: 1, x: 0.5, y: 0.5 }); pump();
    await advance(1100);
    expect(b.received.pings).toBe(1);
    a.room.setAudience({ mode: 'all', peers: [] }); await advance(1100);
    a.room.sendPing('danger', { d: 1, x: 0.5, y: 0.5 }); pump();
    expect(c.received.pings).toBe(1);
  });

  it('stops queued stills and clears private announcements when a recipient is removed', async () => {
    const a = side(1, 'lan'); const b = side(2, 'lan');
    await Promise.all(sides.map((s) => s.room.join(CODE))); pump();
    a.room.setAudience({ mode: 'selected', peers: [b.room.self] });
    a.state.hashes = [HASH]; a.room.profileChanged(); pump();
    expect(a.transfer.stats.sending).toBe(1);
    a.room.setAudience({ mode: 'self', peers: [] }); pump(); await advance(100);
    expect(a.transfer.stats.sending).toBe(0); expect(b.cache.size).toBe(0);
    b.room.leave(); pump();
    expect(a.room.state().audience?.peers).toEqual([]);
  });

  it('moves a full 5 MiB animation through internet media while selected pings still arrive', async () => {
    const a = side(1, 'internet'); const b = side(2, 'internet'); const c = side(3, 'internet');
    await Promise.all(sides.map((s) => s.room.join(CODE))); pump();
    a.room.setAudience({ mode: 'selected', peers: [b.room.self] });
    a.state.hashes = [HASH]; a.room.profileChanged(); pump();
    await advance(1000);
    a.room.sendPing('danger', { d: 1, x: 0.5, y: 0.5 }); pump();
    for (let at = 0; at < 2000 && !b.animationCache.size; at++) await advance(100);
    expect(Buffer.from([...b.animationCache.values()][0] ?? []).equals(a.original)).toBe(true);
    expect(b.received.pings).toBe(1); expect(c.received.pings).toBe(0);
    expect(c.animationCache.size).toBe(0);
    expect(a.mediaPackets.every((s) => s.peer === b.room.self && s.bytes.length <= 1200)).toBe(true);
    const before = a.mediaPackets.length;
    a.state.media = false; a.room.profileChanged(); a.room.mediaChanged(); pump(); await advance(1000);
    expect(a.mediaPackets).toHaveLength(before);
    expect(a.room.canSyncAnimation(b.room.self)).toBe(false);
  });
});
