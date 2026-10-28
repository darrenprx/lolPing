import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../../src/main/roomManager';
import { makeIdentity, open, openShot, seal, sealShot, signBody, type RoomKeys } from '../../src/main/roomCrypto';
import { decodeSigned, encodeMessage, joinSigned, type RoomMessage } from '../../src/shared/roomProtocol';
import { DEFAULT_ROOM_SHOTS, type ShotMeta } from '../../src/shared/roomShots';
import { formatRoomCode, makeRoomCode } from '../../src/shared/roomCode';
import { FakeTransport } from './fixtures/fakeTransport';

const KEYS: RoomKeys = { msgKey: Buffer.alloc(32, 5), relayTopic: 'test-only' };
const CODE = formatRoomCode(makeRoomCode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])));
const batch = '1'.repeat(16);
const meta: ShotMeta = { t: 'shot', id: batch, rev: 1, d: 1, x: 0.5, y: 0.5, w: 640, h: 360,
  bytes: 3, hash: 'a'.repeat(64), marks: [{ x: 0.5, y: 0.5, n: 1 }], status: 'ready' };
let rooms: RoomManager[] = [];
beforeEach(() => { vi.useFakeTimers({ now: 1_780_000_000_000 }); });
afterEach(() => { for (const r of rooms) r.leave(); rooms = []; vi.useRealTimers(); });

async function pair(lane: 'lan' | 'internet' = 'lan', capable = true) {
  const transports = [new FakeTransport(lane), new FakeTransport(lane)];
  const receive = [true, true];
  rooms = transports.map((t, i) => new RoomManager({ transports: [t], now: Date.now,
    randomBytes: (n) => new Uint8Array(n).fill(i + 1), deriveKeys: async () => KEYS, appVersion: '0.6.0',
    profile: () => ({ name: `Peer ${i}`, color: i, rgb: null, limit: 5, nf: [],
      shots: i === 0 || capable, receiveShots: receive[i], markerLimits: DEFAULT_ROOM_SHOTS }),
    announceEmotes: () => [], resolveTarget: () => ({ displayId: 1, width: 1920, height: 1080 }) }));
  const cursors = [0, 0];
  const flush = (): void => {
    for (let loops = 0; loops < 8; loops++) for (let i = 0; i < 2; i++) {
      while (cursors[i] < transports[i].sent.length) {
        const packet = transports[i].sent[cursors[i]++].packet;
        transports[1 - i].deliver(`${lane === 'lan' ? 'lan' : 'net'}:peer${i}:47474`, packet);
      }
    }
  };
  await Promise.all(rooms.map((r) => r.join(CODE))); flush(); await vi.advanceTimersByTimeAsync(3000); flush();
  return { transports, flush, receive, a: rooms[0], b: rooms[1] };
}

describe('room screenshot wire compatibility', () => {
  it('keeps normal packets capped and old readers reject the separate encrypted image format', () => {
    const packet = sealShot(KEYS.msgKey, new Uint8Array(10_000));
    expect(open(KEYS.msgKey, packet)).toBeNull(); expect(openShot(KEYS.msgKey, packet)).toHaveLength(10_000);
    expect(() => seal(KEYS.msgKey, new Uint8Array(1200))).toThrow();
    expect(() => sealShot(KEYS.msgKey, new Uint8Array(24_576))).toThrow();
    const tampered = packet.slice(); tampered[20] ^= 1; expect(openShot(KEYS.msgKey, tampered)).toBeNull();
  });
  it.each(['lan', 'internet'] as const)('sends signed encrypted screenshot metadata after its marker over %s', async (lane) => {
    const h = await pair(lane), got: unknown[] = [];
    h.b.on('shot', (msg) => got.push(msg));
    h.a.sendPing('danger', { d: 1, x: 0.5, y: 0.5, batch }); h.flush();
    expect(h.a.sendShot(h.b.self, meta)).toBe(true); h.flush(); expect(got).toHaveLength(1);
    const packet = h.transports[0].sent.find((s) => s.packet[0] === 2)?.packet;
    expect(packet).toBeDefined();
    const decoded = packet && decodeSigned(openShot(KEYS.msgKey, packet) ?? new Uint8Array());
    expect(decoded && decoded.msg.t).toBe('shot'); expect(decoded && decoded.sig).toBeTruthy();
  });
  it('leaves old clients on ordinary markers without attempting attachments', async () => {
    const h = await pair('lan', false), ping = vi.fn(); h.b.on('remotePing', ping);
    h.a.sendPing('danger', { d: 1, x: 0.5, y: 0.5, batch }); h.flush();
    expect(ping).toHaveBeenCalledTimes(1); expect(h.a.shotPeers()).toHaveLength(0);
    expect(h.a.sendShot(h.b.self, meta)).toBe(false);
  });
  it('applies the per-member cooldown before the older per-second budget and recovers at its deadline', async () => {
    const h = await pair(), ping = vi.fn(); h.b.on('remotePing', ping);
    for (let i = 0; i < 6; i++) { h.a.sendPing('danger', { d: 1, x: 0.5, y: 0.5, batch }); h.flush(); }
    expect(ping).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(6000); h.flush();
    h.a.sendPing('danger', { d: 1, x: 0.5, y: 0.5, batch }); h.flush(); expect(ping).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(4000); h.flush();
    h.a.sendPing('danger', { d: 1, x: 0.5, y: 0.5, batch }); h.flush(); expect(ping).toHaveBeenCalledTimes(6);
  });
  it('rejects unbound screenshots, muted members and delayed attachments after pause', async () => {
    const h = await pair(), got = vi.fn(); h.b.on('shot', got);
    h.a.sendShot(h.b.self, meta); h.flush(); expect(got).not.toHaveBeenCalled();
    h.a.sendEmote('gg', { d: 1, x: 0.5, y: 0.5, batch }); h.flush();
    h.b.setStatusFlags({ paused: true, roomMuted: false });
    h.a.sendShot(h.b.self, meta); h.flush();
    h.b.setStatusFlags({ paused: false, roomMuted: false });
    h.a.sendShot(h.b.self, meta); h.flush(); expect(got).not.toHaveBeenCalled();
    h.a.sendPing('danger', { d: 1, x: 0.5, y: 0.5, batch }); h.flush();
    h.b.muteMember(h.a.self, true); h.a.sendShot(h.b.self, meta); h.flush(); expect(got).not.toHaveBeenCalled();
  });
  it('advertises receive-off while preserving ordinary markers and screenshot serving capability', async () => {
    const h = await pair(), ping = vi.fn(); h.b.on('remotePing', ping);
    h.receive[1] = false; h.b.profileChanged(); h.flush();
    h.a.sendPing('danger', { d: 1, x: 0.5, y: 0.5, batch }); h.flush();
    expect(ping).toHaveBeenCalledTimes(1); expect(h.a.shotPeers()).toHaveLength(0);
  });
  it('refuses ordinary controls wrapped in image packets even when correctly signed', async () => {
    const h = await pair(), got = vi.fn(); h.b.on('remotePing', got);
    const identity = makeIdentity(new Uint8Array(32).fill(1));
    const bytes = encodeMessage({ t: 'ping', peer: h.a.self, seq: 500, ts: Date.now(), ping: 'danger', d: 1, x: 0.5, y: 0.5 } as RoomMessage);
    const text = joinSigned(new TextDecoder().decode(bytes), signBody(identity, bytes));
    h.transports[1].deliver('lan:peer0:47474', sealShot(KEYS.msgKey, new TextEncoder().encode(text)));
    expect(got).not.toHaveBeenCalled();
  });
});
