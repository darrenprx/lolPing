import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeIdentity, open, peerIdOf, publicKeyOf, seal, signBody, verifyBody, type RoomIdentity, type RoomKeys,
} from '../../src/main/roomCrypto';
import {
  MAX_MEMBERS, RoomManager, type RemoteEmote, type RemotePing, type RemoteText, type RoomToast,
} from '../../src/main/roomManager';
import { formatRoomCode, makeRoomCode } from '../../src/shared/roomCode';
import type { TagRgb } from '../../src/shared/roomColors';
import {
  decodeMessage, decodeSigned, encodeMessage, joinSigned, type BallotMsg, type RoomFeatureOff, type RoomMessage, type VoteMsg,
} from '../../src/shared/roomProtocol';
import { FakeTransport } from './fixtures/fakeTransport';

const KEYS: RoomKeys = { msgKey: Buffer.alloc(32, 1), relayTopic: 'room' };
const CODE = makeRoomCode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
const SELF = peerIdOf(makeIdentity(new Uint8Array(32).fill(0xab)).pk);

/** Another lolPing in the room, sending through the fake transport. */
class Remote {
  seq = 0;
  constructor(readonly peer: string, readonly key: string, readonly lan: FakeTransport) {}
  packet(m: Record<string, unknown>, key = KEYS.msgKey): Buffer {
    return seal(key, encodeMessage({ peer: this.peer, seq: ++this.seq, ts: Date.now(), ...m } as RoomMessage));
  }
  presence(extra: Record<string, unknown> = {}): void {
    this.lan.deliver(this.key, this.packet({ t: 'presence', proto: 1, app: '0.3.0', name: `P${this.peer[0]}`, color: 2, status: 'on', ...extra }));
  }
  ping(extra: Record<string, unknown> = {}): void {
    this.lan.deliver(this.key, this.packet({ t: 'ping', ping: 'danger', d: 1, x: 0.5, y: 0.25, ...extra }));
  }
  emote(extra: Record<string, unknown> = {}): void {
    this.lan.deliver(this.key, this.packet({ t: 'emote', e: 'gg', d: 1, x: 0.5, y: 0.25, ...extra }));
  }
  text(extra: Record<string, unknown> = {}): void {
    this.lan.deliver(this.key, this.packet({ t: 'text', text: 'push mid', d: 1, x: 0.5, y: 0.25, ...extra }));
  }
  alive(extra: Record<string, unknown> = {}): void {
    this.lan.deliver(this.key, this.packet({ t: 'alive', who: this.peer, d: 1, x: 0.5, y: 0.25, ...extra }));
  }
  vote(extra: Record<string, unknown> = {}): void {
    this.lan.deliver(this.key, this.packet({ t: 'vote', id: '0a1b2c3d', kind: 'ff', ...extra }));
  }
  ballot(extra: Record<string, unknown> = {}): void {
    this.lan.deliver(this.key, this.packet({ t: 'ballot', id: '0a1b2c3d', yes: true, ...extra }));
  }
  bye(): void {
    this.lan.deliver(this.key, this.packet({ t: 'bye' }));
  }
}

/** A 0.5.2 lolPing: its id is its key's hash, its presence carries the key, and everything but a chunk is signed. */
class SignedRemote extends Remote {
  readonly id: RoomIdentity;
  constructor(seed: number, key: string, lan: FakeTransport) {
    const id = makeIdentity(new Uint8Array(32).fill(seed));
    super(peerIdOf(id.pk), key, lan);
    this.id = id;
  }
  override packet(m: Record<string, unknown>, key = KEYS.msgKey, signer: RoomIdentity = this.id): Buffer {
    const extra = m.t === 'presence' ? { pk: this.id.pk.toString('base64') } : {};
    const body = encodeMessage({ peer: this.peer, seq: ++this.seq, ts: Date.now(), ...m, ...extra } as RoomMessage);
    if (m.t === 'chunk') return seal(key, body);
    const text = new TextDecoder().decode(body);
    return seal(key, new TextEncoder().encode(joinSigned(text, signBody(signer, body))));
  }
}

/** An unsigned packet claiming to be from `peer`, as a hostile member (or a 0.5.1 app) could send. */
function forged(peer: string, m: Record<string, unknown>, seq = 1): Buffer {
  return seal(KEYS.msgKey, encodeMessage({ peer, seq, ts: Date.now(), ...m } as RoomMessage));
}

let lan: FakeTransport;
let room: RoomManager;
let profile: { name: string; color: number; rgb: TagRgb | null; limit: number; nf: RoomFeatureOff[] };
let pings: RemotePing[];
let emotes: RemoteEmote[];
let texts: RemoteText[];
let toasts: RoomToast[];
let saved: (string | null)[];

function sentMessages(to?: string): RoomMessage[] {
  return lan.sent
    .filter((s) => to === undefined || s.to === to)
    .map((s) => decodeMessage(open(KEYS.msgKey, s.packet)!)!);
}

async function joinActive(): Promise<void> {
  expect(await room.join(formatRoomCode(CODE))).toEqual({ ok: true });
  await vi.advanceTimersByTimeAsync(3000);
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_780_000_000_000 });
  lan = new FakeTransport('lan');
  profile = { name: 'Me', color: 1, rgb: null, limit: 5, nf: [] };
  pings = [];
  emotes = [];
  texts = [];
  toasts = [];
  saved = [];
  room = new RoomManager({
    transports: [lan],
    now: () => Date.now(),
    randomBytes: (n) => new Uint8Array(n).fill(0xab),
    deriveKeys: async () => KEYS,
    appVersion: '0.3.0',
    profile: () => profile,
    resolveTarget: (d) => (d === 1 ? { displayId: 100, width: 1920, height: 1080 } : null),
    announceEmotes: () => [],
  });
  room.on('remotePing', (p: RemotePing) => pings.push(p));
  room.on('remoteEmote', (p: RemoteEmote) => emotes.push(p));
  room.on('remoteText', (p: RemoteText) => texts.push(p));
  room.on('toast', (t: RoomToast) => toasts.push(t));
  room.on('saveCode', (c: string | null) => saved.push(c));
});

afterEach(() => {
  room.quit();
  vi.useRealTimers();
});

describe('joining', () => {
  it('create() joins a new room, announces itself and becomes active after 3 s', async () => {
    await room.create();
    expect(room.state().phase).toBe('joining');
    expect(lan.started).toBe(KEYS);
    expect(sentMessages('*')[0]).toMatchObject({ t: 'presence', peer: SELF, name: 'Me', color: 1, status: 'on', proto: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    const s = room.state();
    expect(s.phase).toBe('active');
    expect(s.code).toMatch(/^PING-/);
    expect(saved).toHaveLength(1);
    expect(toasts).toEqual([{ kind: 'joinedRoom', code: s.code }]);
  });

  it('rejects text without a code, and a mistyped code, without starting anything', async () => {
    expect(await room.join('hello')).toEqual({ ok: false, error: 'invalid' });
    const typo = CODE.slice(0, 9) + (CODE[9] === '0' ? '1' : '0');
    expect(await room.join(typo)).toEqual({ ok: false, error: 'mistyped' });
    expect(lan.started).toBeNull();
    expect(room.state().phase).toBe('idle');
  });

  it(`leaves a room that already has ${MAX_MEMBERS} other members`, async () => {
    await room.join(CODE);
    for (let i = 0; i < MAX_MEMBERS; i++) {
      new Remote(i.toString(16).repeat(16), `lan:10.0.0.${i}:47474`, lan).presence();
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(room.state().phase).toBe('idle');
    expect(toasts).toEqual([{ kind: 'full' }]);
    expect(sentMessages('*').at(-1)?.t).toBe('bye');
    expect(lan.started).toBeNull();
    expect(saved).toEqual([]);
  });

  it('joining another room leaves the first one', async () => {
    await joinActive();
    const other = makeRoomCode(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9, 9]));
    await room.join(other);
    expect(sentMessages('*').some((m) => m.t === 'bye')).toBe(true);
    expect(room.state().code).toBe(formatRoomCode(other));
  });
});

describe('members', () => {
  it('adds a member on presence and answers it once, directly', async () => {
    await joinActive();
    const alex = new Remote('1111111111111111', 'lan:10.0.0.2:47474', lan);
    alex.presence({ name: 'Alex', color: 4 });
    alex.presence({ name: 'Alex', color: 4 });
    expect(sentMessages('lan:10.0.0.2:47474').filter((m) => m.t === 'presence')).toHaveLength(1);
    const s = room.state();
    expect(s.members[0]).toMatchObject({ self: true, name: 'Me' });
    expect(s.members[1]).toMatchObject({ peer: alex.peer, name: 'Alex', color: 4, path: 'lan', status: 'on', self: false });
    expect(toasts.at(-1)).toEqual({ kind: 'joined', name: 'Alex' });
  });

  it('does not toast members that were already there when joining', async () => {
    await room.join(CODE);
    new Remote('1111111111111111', 'lan:a', lan).presence();
    await vi.advanceTimersByTimeAsync(3000);
    expect(toasts.map((t) => t.kind)).toEqual(['joinedRoom']);
  });

  it('marks a member on another protocol version as needing an update', async () => {
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence({ proto: 2 });
    expect(room.state().members[1].needsUpdate).toBe(true);
  });

  it('flags members too old for emotes, and no one else', async () => {
    await joinActive();
    const old = new Remote('1111111111111111', 'lan:a', lan);
    const current = new Remote('2222222222222222', 'lan:b', lan);
    const odd = new Remote('3333333333333333', 'lan:c', lan);
    old.presence({ app: '0.4.0' });
    current.presence({ app: '0.5.0' });
    odd.presence({ app: 'room-peer' });
    const flags = (): Record<string, boolean> => Object.fromEntries(room.state().members.map((m) => [m.peer, m.noEmotes]));
    expect(flags()).toEqual({ [SELF]: false, [old.peer]: true, [current.peer]: false, [odd.peer]: false });
    old.presence({ app: '0.5.1' }); // updated and relaunched under the same peer ID
    expect(flags()[old.peer]).toBe(false);
  });

  it('ignores packets sealed with another key, and its own messages', async () => {
    await joinActive();
    const stranger = new Remote('1111111111111111', 'lan:a', lan);
    lan.deliver('lan:a', stranger.packet({ t: 'presence', proto: 1, app: '1', name: 'X', color: 0, status: 'on' }, Buffer.alloc(32, 2)));
    new Remote(SELF, 'lan:me', lan).presence();
    expect(room.state().members).toHaveLength(1);
  });

  it('falls back to connecting after 6 s of silence and drops the member after 15 s', async () => {
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence({ name: 'Alex' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(room.state().members[1].path).toBe('connecting');
    await vi.advanceTimersByTimeAsync(9000);
    expect(room.state().members).toHaveLength(1);
    expect(toasts.at(-1)).toEqual({ kind: 'disconnected', name: 'Alex' });
  });

  it('brings a member back quietly when the same peer ID returns after a timeout', async () => {
    await joinActive();
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence({ name: 'Alex' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(toasts.map((t) => t.kind)).toEqual(['joinedRoom', 'joined', 'disconnected']);
    alex.presence({ name: 'Alex' }); // the same app, awake again
    expect(room.state().members.map((m) => m.name)).toEqual(['Me', 'Alex']);
    expect(toasts.map((t) => t.kind)).toEqual(['joinedRoom', 'joined', 'disconnected']);
  });

  it('announces a member that comes back under a new peer ID, because that one joined again', async () => {
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence({ name: 'Alex' });
    await vi.advanceTimersByTimeAsync(15_000);
    new Remote('2222222222222222', 'lan:a', lan).presence({ name: 'Alex' });
    expect(toasts.at(-1)).toEqual({ kind: 'joined', name: 'Alex' });
  });

  it('gives members a fresh grace period after the computer slept, instead of "disconnected" toasts', async () => {
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence({ name: 'Alex' });
    vi.setSystemTime(Date.now() + 60_000); // asleep: the clock moved, no timers ran
    await vi.advanceTimersByTimeAsync(1000);
    expect(room.state().members.map((m) => m.name)).toEqual(['Me', 'Alex']);
    expect(toasts.some((t) => t.kind === 'disconnected')).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000); // and really gone: dropped as usual
    expect(room.state().members).toHaveLength(1);
    expect(toasts.at(-1)).toEqual({ kind: 'disconnected', name: 'Alex' });
  });

    it('removes a member that says bye and ignores it afterwards', async () => {
    await joinActive();
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence({ name: 'Alex' });
    alex.bye();
    expect(room.state().members).toHaveLength(1);
    expect(toasts.at(-1)).toEqual({ kind: 'left', name: 'Alex' });
    alex.presence({ name: 'Alex' });
    expect(room.state().members).toHaveLength(1);
  });

  /** A presence sealed with the room key but stamped an hour ago: a captured packet replayed later, or a bad clock. */
  const stalePresence = (r: Remote, name = 'Old') => lan.deliver(r.key, seal(KEYS.msgKey, encodeMessage({
    t: 'presence', peer: r.peer, seq: ++r.seq, ts: Date.now() - 3_600_000, proto: 1, app: '1', name, color: 0, status: 'on', em: [], nf: [],
  })));

  it('never adds, answers or counts a member from stale packets, so replays cannot fill the room', async () => {
    await room.join(CODE);
    const ghosts = Array.from({ length: 8 }, (_, i) => new Remote(`${i}`.repeat(16), `lan:66.6.6.6:${i}`, lan));
    lan.sent = [];
    for (const g of ghosts) for (let n = 0; n < 4; n++) stalePresence(g, `Old${g.peer[0]}`);
    await vi.advanceTimersByTimeAsync(3000);
    expect(room.state().phase).toBe('active');
    expect(room.state().members).toHaveLength(1);
    expect(lan.sent.filter((s) => s.to.startsWith('lan:66.6.6.6'))).toHaveLength(0);
    expect(toasts.map((t) => t.kind)).toEqual(['joinedRoom']);
  });

  it('warns about a clock more than 10 minutes off without adding anyone, then clears', async () => {
    await joinActive();
    const late = new Remote('1111111111111111', 'lan:a', lan);
    stalePresence(late);
    stalePresence(late);
    expect(room.state().clockSkew).toBe(false);
    stalePresence(late);
    expect(room.state()).toMatchObject({ clockSkew: true, members: [expect.objectContaining({ self: true })] });
    expect(room.state().members).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(room.state().clockSkew).toBe(false);
  });

  it('becomes lonely after 20 s alone', async () => {
    await joinActive();
    expect(room.state().lonely).toBe(false);
    await vi.advanceTimersByTimeAsync(17_000);
    expect(room.state().lonely).toBe(true);
    new Remote('1111111111111111', 'lan:a', lan).presence();
    expect(room.state().lonely).toBe(false);
  });
});

describe('incoming pings', () => {
  let alex: Remote;
  beforeEach(async () => {
    await joinActive();
    alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence({ name: 'Alex', color: 4 });
  });

  it('maps a ping onto the target display with the sender’s tag', () => {
    alex.ping({ ping: 'push', x: 0.5, y: 0.25 });
    expect(pings).toEqual([{ displayId: 100, x: 960, y: 270, id: 'push', tag: { name: 'Alex', color: 4, rgb: null } }]);
  });

  it('shows a packet that arrives twice only once', () => {
    const packet = alex.packet({ t: 'ping', ping: 'danger', d: 1, x: 0, y: 0 });
    lan.deliver('lan:a', packet);
    lan.deliver('lan:b', packet);
    expect(pings).toHaveLength(1);
  });

  it('drops pings from strangers, while paused, while the room is muted and from muted members', () => {
    new Remote('2222222222222222', 'lan:c', lan).ping();
    room.setStatusFlags({ paused: true, roomMuted: false });
    alex.ping();
    room.setStatusFlags({ paused: false, roomMuted: true });
    alex.ping();
    room.setStatusFlags({ paused: false, roomMuted: false });
    room.muteMember(alex.peer, true);
    alex.ping();
    expect(pings).toHaveLength(0);
    room.muteMember(alex.peer, false);
    alex.ping();
    expect(pings).toHaveLength(1);
  });

  it('drops pings from a member that needs an update', () => {
    alex.presence({ proto: 2 });
    alex.ping();
    expect(pings).toHaveLength(0);
  });

  it('rate-limits each member, 0 meaning unlimited', () => {
    profile.limit = 2;
    for (let i = 0; i < 5; i++) alex.ping();
    expect(pings).toHaveLength(2);
    profile.limit = 0;
    for (let i = 0; i < 50; i++) alex.ping();
    expect(pings).toHaveLength(52);
  });

  it('drops a ping when there is no display to show it on', () => {
    alex.ping({ d: 3 }); // this setup's resolveTarget only knows display 1
    expect(pings).toHaveLength(0);
  });
});

describe('incoming emotes', () => {
  let alex: Remote;
  beforeEach(async () => {
    await joinActive();
    alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence({ name: 'Pa', color: 2 });
  });

  it('emits remote emotes with the sender’s tag, mapped onto the target display', () => {
    alex.emote({ e: 'gg', d: 1, x: 0.5, y: 0.25 });
    expect(emotes).toEqual([{ displayId: 100, x: 960, y: 270, ref: 'gg', peer: alex.peer, tag: { name: 'Pa', color: 2, rgb: null } }]);
    expect(pings).toHaveLength(0);
  });

  it('passes a custom ref and an unknown slug on unchanged, for the overlay to resolve', () => {
    const custom = `c:${'ab'.repeat(16)}`;
    alex.emote({ e: custom });
    alex.emote({ e: 'from_the_future' });
    expect(emotes.map((e) => e.ref)).toEqual([custom, 'from_the_future']);
  });

  it('carries the sender’s effect on the emote, and nothing when they left it out', () => {
    alex.emote({ fx: 5 });
    alex.emote({ fx: 6 }); // out of range: dropped, not the emote
    alex.emote({});
    expect(emotes.map((e) => e.fx)).toEqual([5, undefined, undefined]);
  });

  it('keeps an emote at the very edge of the display inside it', () => {
    alex.emote({ x: 0, y: 1 });
    expect(emotes[0]).toMatchObject({ x: 0, y: 1080 });
  });

  it('drops an emote outside the display before it reaches the overlay, like a ping', () => {
    for (const bad of [{ x: 1.5 }, { y: -0.1 }, { x: Number.NaN }, { d: 0 }, { e: 'No Way' }]) alex.emote(bad);
    expect(emotes).toHaveLength(0);
  });

  it('uses the ping gates: strangers, paused, room muted, member muted and needs-update', () => {
    new Remote('2222222222222222', 'lan:c', lan).emote();
    room.setStatusFlags({ paused: true, roomMuted: false });
    alex.emote();
    room.setStatusFlags({ paused: false, roomMuted: true });
    alex.emote();
    room.setStatusFlags({ paused: false, roomMuted: false });
    room.muteMember(alex.peer, true);
    alex.emote();
    room.muteMember(alex.peer, false);
    alex.presence({ proto: 2 });
    alex.emote();
    expect(emotes).toHaveLength(0);
    alex.presence({ proto: 1 });
    alex.emote();
    expect(emotes).toHaveLength(1);
  });

  it('drops an emote when there is no display to show it on, and shows a packet that arrives twice once', () => {
    alex.emote({ d: 3 }); // this setup's resolveTarget only knows display 1
    expect(emotes).toHaveLength(0);
    const packet = alex.packet({ t: 'emote', e: 'gg', d: 1, x: 0, y: 0 });
    lan.deliver('lan:a', packet);
    lan.deliver('lan:b', packet);
    expect(emotes).toHaveLength(1);
  });

  it('shares the incoming limit with pings', () => {
    profile.limit = 5;
    for (let i = 0; i < 3; i++) {
      alex.ping();
      alex.emote();
    }
    expect(pings.length + emotes.length).toBe(5);
  });
});

describe('outgoing', () => {
  it('sends an emote to each member over its path, and nothing when idle or paused', async () => {
    room.sendEmote('gg', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent).toHaveLength(0);
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence();
    new Remote('2222222222222222', 'lan:b', lan).presence();
    lan.sent = [];
    room.sendEmote('gg', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent.map((s) => s.to).sort()).toEqual(['lan:a', 'lan:b']);
    expect(sentMessages('lan:a')[0]).toMatchObject({ t: 'emote', e: 'gg', d: 1, x: 0.1, y: 0.2, peer: SELF });
    expect(sentMessages('lan:a')[0]).not.toHaveProperty('fx'); // the plain pop leaves the field out
    lan.sent = [];
    room.sendEmote('gg', { d: 1, x: 0.1, y: 0.2 }, 5);
    expect(sentMessages('lan:a')[0]).toMatchObject({ t: 'emote', e: 'gg', fx: 5, peer: SELF });
    room.setStatusFlags({ paused: true, roomMuted: false });
    lan.sent = [];
    room.sendEmote('gg', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent).toHaveLength(0);
    room.setStatusFlags({ paused: false, roomMuted: true }); // muting the room only silences what we hear
    lan.sent = [];
    room.sendEmote('gg', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent).toHaveLength(2);
  });

  it('sends a ping to each member over its path, and nothing when idle or paused', async () => {
    room.sendPing('omw', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent).toHaveLength(0);
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence();
    new Remote('2222222222222222', 'lan:b', lan).presence();
    lan.sent = [];
    room.sendPing('omw', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent.map((s) => s.to).sort()).toEqual(['lan:a', 'lan:b']);
    expect(sentMessages('lan:a')[0]).toMatchObject({ t: 'ping', ping: 'omw', d: 1, x: 0.1, y: 0.2, peer: SELF });
    lan.sent = [];
    room.setStatusFlags({ paused: true, roomMuted: false });
    lan.sent = [];
    room.sendPing('omw', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent).toHaveLength(0);
    room.setStatusFlags({ paused: false, roomMuted: true });
    lan.sent = [];
    room.sendPing('omw', { d: 1, x: 0.1, y: 0.2 });
    expect(lan.sent).toHaveLength(2);
  });

  it('announces a status change right away', async () => {
    await joinActive();
    lan.sent = [];
    room.setStatusFlags({ paused: true, roomMuted: false });
    expect(sentMessages('*')).toEqual([expect.objectContaining({ t: 'presence', status: 'paused' })]);
    lan.sent = [];
    room.setStatusFlags({ paused: false, roomMuted: true });
    expect(sentMessages('*')).toEqual([expect.objectContaining({ t: 'presence', status: 'muted' })]);
  });

  it('also sends presence and bye straight to known members (Wi-Fi broadcast is lossy)', async () => {
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence();
    lan.sent = [];
    room.setStatusFlags({ paused: true, roomMuted: false });
    expect(sentMessages('lan:a')).toEqual([expect.objectContaining({ t: 'presence', status: 'paused' })]);
    lan.sent = [];
    room.leave();
    expect(sentMessages('lan:a').map((m) => m.t)).toEqual(['bye']);
  });

  it('announces on a transport as soon as it comes up (after a bind or rebind)', async () => {
    await joinActive();
    lan.sent = [];
    lan.setStatus('starting');
    lan.setStatus('ok');
    expect(sentMessages('*')).toEqual([expect.objectContaining({ t: 'presence' })]);
  });

  it('re-announces every 2 s and after a profile change', async () => {
    await joinActive();
    lan.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(sentMessages('*').filter((m) => m.t === 'presence').length).toBeGreaterThanOrEqual(1);
    lan.sent = [];
    profile.name = 'Renamed';
    room.profileChanged();
    expect(sentMessages('*')).toEqual([expect.objectContaining({ name: 'Renamed' })]);
  });

  it('leave() says bye, stops and forgets the code; quit() keeps it', async () => {
    await joinActive();
    lan.sent = [];
    room.leave();
    expect(sentMessages('*').map((m) => m.t)).toEqual(['bye']);
    expect(lan.started).toBeNull();
    expect(saved.at(-1)).toBeNull();
    expect(room.state()).toMatchObject({ phase: 'idle', code: null, members: [] });

    await joinActive();
    const before = saved.length;
    room.quit();
    expect(saved).toHaveLength(before);
    expect(room.state().phase).toBe('idle');
  });

  it('uses a new peer ID on every join, so leaving and coming back is not mistaken for a replay', async () => {
    let n = 0;
    const fresh = new RoomManager({
      transports: [lan], now: () => Date.now(), randomBytes: (k) => Uint8Array.from({ length: k }, () => ++n & 255),
      deriveKeys: async () => KEYS, appVersion: '0.3.0', profile: () => profile, resolveTarget: () => null, announceEmotes: () => [],
    });
    await fresh.join(CODE);
    const first = sentMessages('*').at(-1)!;
    fresh.leave();
    lan.sent = [];
    await fresh.join(CODE);
    const second = sentMessages('*')[0];
    expect(second.peer).not.toBe(first.peer);
    expect(second.seq).toBe(1);
    fresh.quit();
  });

  it('goes back to idle and reports failure when the keys cannot be derived', async () => {
    const broken = new RoomManager({
      transports: [lan], now: () => Date.now(), randomBytes: (k) => new Uint8Array(k), appVersion: '0.3.0',
      deriveKeys: async () => { throw new Error('out of memory'); }, profile: () => profile, resolveTarget: () => null, announceEmotes: () => [],
    });
    expect(await broken.join(CODE)).toEqual({ ok: false, error: 'failed' });
    expect(broken.state().phase).toBe('idle');
    await expect(broken.create()).resolves.toBeUndefined();
    expect(broken.state().phase).toBe('idle');
    expect(lan.started).toBeNull();
  });

    it('a leave() while the keys are still being derived wins', async () => {
    const pending = room.join(CODE);
    room.leave();
    await pending;
    await vi.advanceTimersByTimeAsync(3000);
    expect(room.state().phase).toBe('idle');
    expect(lan.started).toBeNull();
  });
});

describe('two transports', () => {
  let net: FakeTransport;
  let both: RoomManager;
  let got: RemotePing[];
  beforeEach(async () => {
    net = new FakeTransport('internet');
    got = [];
    both = new RoomManager({
      transports: [lan, net], now: () => Date.now(), randomBytes: (n) => new Uint8Array(n).fill(0xcd),
      deriveKeys: async () => KEYS, appVersion: '0.3.0', profile: () => profile,
      resolveTarget: () => ({ displayId: 1, width: 100, height: 100 }),
      announceEmotes: () => [],
    });
    both.on('remotePing', (p: RemotePing) => got.push(p));
    await both.join(CODE);
    await vi.advanceTimersByTimeAsync(3000);
  });
  afterEach(() => both.quit());

  it('uses LAN while it is alive, falls back to the internet, and returns to LAN', async () => {
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence();
    net.deliver('net:x', alex.packet({ t: 'presence', proto: 1, app: '1', name: 'Alex', color: 1, status: 'on' }));
    expect(both.state().members[1].path).toBe('lan');
    await vi.advanceTimersByTimeAsync(6000);
    net.deliver('net:x', alex.packet({ t: 'presence', proto: 1, app: '1', name: 'Alex', color: 1, status: 'on' }));
    expect(both.state().members[1].path).toBe('internet');
    lan.sent = [];
    net.sent = [];
    both.sendPing('omw', { d: 1, x: 0, y: 0 });
    expect([lan.sent.length, net.sent.map((s) => s.to)]).toEqual([0, ['*']]); // relays: one send reaches everyone
    alex.presence();
    expect(both.state().members[1].path).toBe('lan');
  });

  it('shows a ping that arrives over both transports once', () => {
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence();
    const packet = alex.packet({ t: 'ping', ping: 'push', d: 1, x: 0.5, y: 0.5 });
    lan.deliver('lan:a', packet);
    net.deliver('net:x', packet);
    expect(got).toHaveLength(1);
  });

  it('unicasts presence only on LAN (one relay send already reaches everyone)', () => {
    new Remote('1111111111111111', 'lan:a', lan).presence();
    net.deliver('net:x', new Remote('2222222222222222', 'net:x', lan).packet({ t: 'presence', proto: 1, app: '1', name: 'B', color: 1, status: 'on' }));
    vi.advanceTimersByTime(1000); // relays: at most one presence a second
    lan.sent = [];
    net.sent = [];
    both.profileChanged();
    expect(lan.sent.map((s) => s.to).sort()).toEqual(['*', 'lan:a']);
    expect(net.sent.map((s) => s.to)).toEqual(['*']);
  });
});

describe('internet over a shared transport', () => {
  let net: FakeTransport;
  let inet: RoomManager;
  let gone: RoomToast[];
  const make = (transports: FakeTransport[]): RoomManager => {
    const r = new RoomManager({
      transports, now: () => Date.now(), randomBytes: (n) => new Uint8Array(n).fill(0xef),
      deriveKeys: async () => KEYS, appVersion: '0.4.0', profile: () => profile,
      resolveTarget: () => ({ displayId: 1, width: 100, height: 100 }),
      announceEmotes: () => [],
    });
    r.on('toast', (t: RoomToast) => gone.push(t));
    return r;
  };
  const decode = (t: FakeTransport): RoomMessage[] => t.sent.map((s) => decodeMessage(open(KEYS.msgKey, s.packet)!)!);
  const netPresence = (r: Remote, extra: Record<string, unknown> = {}): void =>
    net.deliver(r.key, r.packet({ t: 'presence', proto: 1, app: '0.4.0', name: `P${r.peer[0]}`, color: 3, status: 'on', ...extra }));

  beforeEach(() => {
    net = new FakeTransport('internet');
    gone = [];
    inet = make([lan, net]);
  });
  afterEach(() => inet.quit());

  async function joinNow(): Promise<void> {
    await inet.join(CODE);
    await vi.advanceTimersByTimeAsync(3000);
    expect(inet.state().phase).toBe('active');
  }

  it('sends a ping once over a shared transport, however many members use it', async () => {
    await joinNow();
    netPresence(new Remote('1111111111111111', 'net:a', lan));
    netPresence(new Remote('2222222222222222', 'net:b', lan));
    net.sent = [];
    inet.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
    expect(net.sent.map((s) => s.to)).toEqual(['*']);
    expect(decode(net)[0]).toMatchObject({ t: 'ping', ping: 'omw' });
  });

  it('caps pings over a shared transport at 5/s with bursts of 10, while LAN members still get every ping', async () => {
    await joinNow();
    new Remote('1111111111111111', 'lan:a', lan).presence();
    netPresence(new Remote('2222222222222222', 'net:b', lan));
    lan.sent = [];
    net.sent = [];
    for (let i = 0; i < 15; i++) inet.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
    expect(lan.sent.filter((s) => s.to === 'lan:a')).toHaveLength(15);
    expect(decode(net).filter((m) => m.t === 'ping')).toHaveLength(10);
    net.sent = [];
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 15; i++) inet.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
    expect(decode(net).filter((m) => m.t === 'ping')).toHaveLength(5);
  });

  it('sends an emote once over a shared transport, and pings and emotes share one cap of 5/s with bursts of 10', async () => {
    await joinNow();
    new Remote('1111111111111111', 'lan:a', lan).presence();
    netPresence(new Remote('2222222222222222', 'net:b', lan));
    netPresence(new Remote('3333333333333333', 'net:c', lan));
    lan.sent = [];
    net.sent = [];
    inet.sendEmote('gg', { d: 1, x: 0.5, y: 0.5 });
    expect(net.sent.map((s) => s.to)).toEqual(['*']);
    expect(decode(net)[0]).toMatchObject({ t: 'emote', e: 'gg' });
    net.sent = [];
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 15; i++) {
      if (i % 2) inet.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
      else inet.sendEmote('gg', { d: 1, x: 0.5, y: 0.5 });
    }
    const sent = (): string[] => decode(net).map((m) => m.t).filter((t) => t !== 'presence');
    expect(sent()).toEqual(['emote', 'ping', 'emote', 'ping', 'emote', 'ping', 'emote', 'ping', 'emote', 'ping']);
    const toLan = lan.sent.filter((s) => s.to === 'lan:a').map((s) => decodeMessage(open(KEYS.msgKey, s.packet)!)!.t);
    expect(toLan.filter((t) => t === 'emote' || t === 'ping')).toHaveLength(16); // LAN members still get every one
    net.sent = [];
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 15; i++) inet.sendEmote('gg', { d: 1, x: 0.5, y: 0.5 });
    expect(sent()).toHaveLength(5);
  });

  it('never caps presence or bye over a shared transport', async () => {
    await joinNow();
    netPresence(new Remote('2222222222222222', 'net:b', lan));
    for (let i = 0; i < 20; i++) inet.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
    vi.advanceTimersByTime(1000);
    net.sent = [];
    inet.setStatusFlags({ paused: false, roomMuted: true });
    inet.leave();
    expect(decode(net).map((m) => m.t)).toEqual(['presence', 'bye']);
  });

  it('answers linkUp and new members with presence at once, then at most once a second, the latest state winning', async () => {
    await joinNow();
    vi.advanceTimersByTime(1500);
    net.sent = [];
    net.linkUp();
    expect(decode(net).map((m) => m.t)).toEqual(['presence']);
    netPresence(new Remote('2222222222222222', 'net:b', lan));
    profile.name = 'Later';
    inet.profileChanged();
    expect(decode(net)).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(decode(net)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(decode(net).map((m) => m.t === 'presence' && m.name)).toEqual(['Me', 'Later']);
  });

  it('joining over relays only announces as soon as the first relay is live, not at the 10 s round', async () => {
    const only = make([net]);
    net.startStatus = 'starting';
    await only.join(CODE);
    vi.advanceTimersByTime(300);
    net.sent = [];
    net.linkUp();
    vi.advanceTimersByTime(700);
    expect(decode(net).map((m) => m.t)).toContain('presence');
    only.quit();
  });

  it('settles 3 s after the internet transport leaves starting', async () => {
    net.startStatus = 'starting';
    await inet.join(CODE);
    await vi.advanceTimersByTimeAsync(5000);
    expect(inet.state().phase).toBe('joining');
    net.setStatus('ok');
    await vi.advanceTimersByTimeAsync(2999);
    expect(inet.state().phase).toBe('joining');
    await vi.advanceTimersByTimeAsync(1);
    expect(inet.state().phase).toBe('active');
  });

  it('settles at the 15 s cap when the internet never leaves starting', async () => {
    net.startStatus = 'starting';
    await inet.join(CODE);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(inet.state().phase).toBe('joining');
    await vi.advanceTimersByTimeAsync(1);
    expect(inet.state().phase).toBe('active');
  });

  it('never settles later than the cap when the internet comes up late', async () => {
    net.startStatus = 'starting';
    await inet.join(CODE);
    await vi.advanceTimersByTimeAsync(13_000);
    net.setStatus('ok');
    await vi.advanceTimersByTimeAsync(2000);
    expect(inet.state().phase).toBe('active');
  });

  it('settles after 3 s when internet is not allowed', async () => {
    inet.setInternetAllowed(false);
    net.startStatus = 'starting';
    await inet.join(CODE);
    expect(net.starts).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(inet.state().phase).toBe('active');
    expect(inet.state().internet).toBe('off');
  });

  it('keeps an internet path alive for 25 s and drops an internet member after 30 s', async () => {
    await joinNow();
    netPresence(new Remote('2222222222222222', 'net:b', lan));
    new Remote('1111111111111111', 'lan:a', lan).presence();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(inet.state().members.find((m) => m.peer === '2222222222222222')?.path).toBe('internet');
    expect(inet.state().members.find((m) => m.peer === '1111111111111111')).toBeUndefined(); // LAN only: 15 s
    await vi.advanceTimersByTimeAsync(1000);
    expect(inet.state().members.find((m) => m.peer === '2222222222222222')?.path).not.toBe('internet');
    await vi.advanceTimersByTimeAsync(4000);
    expect(inet.state().members).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inet.state().members).toHaveLength(1);
    expect(gone.filter((t) => t.kind === 'disconnected')).toHaveLength(2);
  });

  it('setInternetAllowed(false) mid-room stops the relay transport without a bye and forgets internet paths', async () => {
    await joinNow();
    netPresence(new Remote('2222222222222222', 'net:b', lan));
    net.sent = [];
    inet.setInternetAllowed(false);
    expect(net.sent).toEqual([]);
    expect(net.started).toBeNull();
    expect(inet.state().internet).toBe('off');
    expect(inet.state().members[1].path).not.toBe('internet');
    inet.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
    expect(net.sent).toEqual([]);
  });

  it('setInternetAllowed(true) mid-room starts it with the current keys and announces', async () => {
    inet.setInternetAllowed(false);
    await joinNow();
    expect(net.starts).toBe(0);
    inet.setInternetAllowed(true);
    expect(net.started).toBe(KEYS);
    expect(decode(net).map((m) => m.t)).toEqual(['presence']);
    expect(inet.state().internet).toBe('ok');
  });

  it('toggling internet off/on/off leaves one stopped relay transport', async () => {
    await joinNow();
    inet.setInternetAllowed(false);
    inet.setInternetAllowed(true);
    inet.setInternetAllowed(false);
    expect(net.starts - net.stops).toBe(0);
    expect(net.started).toBeNull();
    expect(inet.state().internet).toBe('off');
  });
});


describe('emote transfers', () => {
  let emotes: { peer: string; hashes: string[] }[];
  let wants: RoomMessage[];
  let chunks: RoomMessage[];
  const hash = '0123456789abcdef0123456789abcdef';

  /** The room under test, with the self peer id pinned so `want` addressing can be asserted. */
  const make = (): RoomManager => {
    const r = new RoomManager({
      transports: [lan], now: () => Date.now(), randomBytes: (n) => new Uint8Array(n).fill(0xab),
      deriveKeys: async () => KEYS, appVersion: '0.5.1', profile: () => profile,
      resolveTarget: (d) => (d === 1 ? { displayId: 100, width: 1920, height: 1080 } : null),
      announceEmotes: () => [hash],
    });
    r.on('emotes', (peer: string, hashes: string[]) => emotes.push({ peer, hashes }));
    r.on('want', (w: RoomMessage) => wants.push(w));
    r.on('chunk', (c: RoomMessage) => chunks.push(c));
    return r;
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_780_000_000_000 });
    lan = new FakeTransport('lan');
    emotes = [];
    wants = [];
    chunks = [];
    room = make();
    pings = [];
    emotes = [];
    toasts = [];
    saved = [];
  });

  afterEach(() => {
    room.quit();
    vi.useRealTimers();
  });

  it('announces our wheel hashes in every presence, and reads a member’s announcements', async () => {
    await joinActive();
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence({ em: [hash] });
    expect(emotes.at(-1)).toEqual({ peer: '1111111111111111', hashes: [hash] });
    const mine = sentMessages('lan:a').find((m) => m.t === 'presence');
    expect(mine).toMatchObject({ em: [hash] });
  });

  it('hands a want addressed to us to the transfer layer, and drops one aimed elsewhere', async () => {
    await joinActive();
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence();
    lan.sent = [];
    lan.deliver(alex.key, alex.packet({ t: 'want', to: room.self, h: hash, need: [] }));
    lan.deliver(alex.key, alex.packet({ t: 'want', to: '9999999999999999', h: hash, need: [] }));
    expect(wants).toHaveLength(1);
    expect(wants[0]).toMatchObject({ t: 'want', to: room.self });
  });

  it('hands a chunk over, but nothing at all from a muted member', async () => {
    await joinActive();
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence();
    lan.sent = [];
    lan.deliver(alex.key, alex.packet({ t: 'chunk', h: hash, i: 0, n: 2, b: 'QQ==' }));
    expect(chunks).toHaveLength(1);
    room.muteMember('1111111111111111', true);
    lan.deliver(alex.key, alex.packet({ t: 'chunk', h: hash, i: 1, n: 2, b: 'QQ==' }));
    lan.deliver(alex.key, alex.packet({ t: 'want', to: room.self, h: hash, need: [] }));
    expect(chunks).toHaveLength(1);
    expect(wants).toHaveLength(0);
  });

  it('spends shared tokens on chunks only while five stay for pings', async () => {
    await joinActive();
    new Remote('1111111111111111', 'lan:a', lan).presence();
    const spent: boolean[] = [];
    for (let n = 0; n < 7; n++) spent.push(room.spareSharedToken(5));
    expect(spent).toEqual([true, true, true, true, true, false, false]);
    // a ping still goes out afterwards: the bucket kept its burst
    lan.sent = [];
    room.sendPing('omw', { d: 1, x: 0.5, y: 0.5 });
    expect(sentMessages()).toHaveLength(1);
  });

  it('tells the transfer layer when a member is gone, including on quit', async () => {
    await joinActive();
    const gonePeers: string[] = [];
    room.on('memberGone', (peer: string) => gonePeers.push(peer));
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence();
    alex.bye();
    expect(gonePeers).toEqual(['1111111111111111']);
    const ben = new Remote('2222222222222222', 'lan:b', lan);
    ben.presence();
    room.quit();
    expect(gonePeers).toEqual(['1111111111111111', '2222222222222222']);
  });
});

describe('emote transfer gating (audit regressions)', () => {
  const hash = '0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_780_000_000_000 });
    lan = new FakeTransport('lan');
    pings = [];
    emotes = [];
    toasts = [];
    saved = [];
    room = new RoomManager({
      transports: [lan], now: () => Date.now(), randomBytes: (n) => new Uint8Array(n).fill(0xab),
      deriveKeys: async () => KEYS, appVersion: '0.5.2', profile: () => profile,
      resolveTarget: (d) => (d === 1 ? { displayId: 100, width: 1920, height: 1080 } : null),
      announceEmotes: () => [],
    });
  });

  afterEach(() => {
    room.quit();
    vi.useRealTimers();
  });

  it('ignores new members once the room is full, however many presences arrive', async () => {
    await joinActive();
    for (let n = 0; n < MAX_MEMBERS + 4; n++) new Remote(n.toString(16).padStart(16, '0'), `lan:${n}`, lan).presence();
    expect(room.state().members).toHaveLength(MAX_MEMBERS); // we count too: the room never grows past MAX_MEMBERS people
  });

  it('lets at most two members share one LAN address', async () => {
    await joinActive();
    new Remote('1111111111111111', 'lan:same', lan).presence();
    new Remote('2222222222222222', 'lan:same', lan).presence();
    new Remote('3333333333333333', 'lan:same', lan).presence(); // a rebound is fine, a third is forgery
    new Remote('4444444444444444', 'lan:other', lan).presence();
    expect(room.state().members.filter((m) => !m.self)).toHaveLength(3);
  });

  it('counts want and chunk messages against their own per-member bucket', async () => {
    await joinActive();
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence();
    const seen: RoomMessage[] = [];
    room.on('want', (w: RoomMessage) => seen.push(w));
    room.on('chunk', (c: RoomMessage) => seen.push(c));
    for (let n = 0; n < 100; n++) lan.deliver(alex.key, alex.packet({ t: 'want', to: room.self, h: hash, need: [] }));
    expect(seen).toHaveLength(60); // the first sixty pass, the flood behind them meets the wall
    await vi.advanceTimersByTimeAsync(1000);
    lan.deliver(alex.key, alex.packet({ t: 'want', to: room.self, h: hash, need: [] }));
    expect(seen).toHaveLength(61); // the bucket refills for a well-behaved sender
  });

  it('neither fetches nor serves stills while paused, and resumes on the next presence', async () => {
    await joinActive();
    const seen: RoomMessage[] = [];
    let announced: { peer: string; hashes: string[] }[] = [];
    room.on('want', (w: RoomMessage) => seen.push(w));
    room.on('chunk', (c: RoomMessage) => seen.push(c));
    room.on('emotes', (peer: string, hashes: string[]) => announced.push({ peer, hashes }));
    room.setStatusFlags({ paused: true, roomMuted: false });
    const alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence({ em: [hash] });
    lan.deliver(alex.key, alex.packet({ t: 'want', to: room.self, h: hash, need: [] }));
    lan.deliver(alex.key, alex.packet({ t: 'chunk', h: hash, i: 0, n: 2, b: 'QQ==' }));
    expect(seen).toHaveLength(0);
    expect(announced).toHaveLength(0); // no prefetch either: the transfer layer hears nothing

    room.setStatusFlags({ paused: false, roomMuted: false });
    alex.presence({ em: [hash] });
    expect(announced).toHaveLength(1); // the next presence after unpausing starts prefetch again
  });
});

describe('room text and votes', () => {
  let alex: Remote;
  let votes: VoteMsg[];
  let ballots: BallotMsg[];
  beforeEach(async () => {
    votes = [];
    ballots = [];
    room.on('vote', (m: VoteMsg) => votes.push(m));
    room.on('ballot', (m: BallotMsg) => ballots.push(m));
    await joinActive();
    alex = new Remote('1111111111111111', 'lan:a', lan);
    alex.presence({ name: 'Alex', color: 4, app: '0.5.2' });
  });

  it('passes text and alive through the ping gates', () => {
    alex.text({ x: 0.5, y: 0.25 });
    alex.alive({ who: room.self, x: 0.25, y: 0.5 });
    const tag = { name: 'Alex', color: 4, rgb: null };
    expect(texts).toEqual([
      { kind: 'text', peer: alex.peer, tag, displayId: 100, x: 960, y: 270, text: 'push mid' },
      { kind: 'alive', peer: alex.peer, tag, displayId: 100, x: 480, y: 540, who: room.self },
    ]);
    texts.length = 0;
    new Remote('2222222222222222', 'lan:c', lan).text(); // a stranger
    room.setStatusFlags({ paused: true, roomMuted: false });
    alex.text();
    alex.alive();
    room.setStatusFlags({ paused: false, roomMuted: true });
    alex.text();
    room.setStatusFlags({ paused: false, roomMuted: false });
    room.muteMember(alex.peer, true);
    alex.text();
    alex.alive();
    room.muteMember(alex.peer, false);
    alex.text({ d: 3 }); // no such display here
    expect(texts).toHaveLength(0);
    profile.limit = 1;
    vi.advanceTimersByTime(2000);
    alex.text();
    alex.text();
    alex.alive();
    expect(texts).toHaveLength(1); // only the first of three in one second
  });

  it('drops alive about someone who is not in the room, and a member that needs an update', () => {
    alex.alive({ who: '9999999999999999' });
    expect(texts).toHaveLength(0);
    alex.alive({ who: alex.peer });
    expect(texts).toHaveLength(1);
    alex.presence({ proto: 2 });
    alex.text();
    expect(texts).toHaveLength(1);
  });

  it('drops a vote from a muted member but keeps their ballots', () => {
    alex.vote();
    alex.vote({ id: '0a1b2c3e', kind: 'kick', target: room.self });
    expect(votes.map((v) => [v.id, v.kind, v.target, v.peer])).toEqual([
      ['0a1b2c3d', 'ff', undefined, alex.peer],
      ['0a1b2c3e', 'kick', room.self, alex.peer],
    ]);
    room.muteMember(alex.peer, true);
    alex.vote({ id: '0a1b2c3f' });
    expect(votes).toHaveLength(2);
    alex.ballot();
    expect(ballots).toMatchObject([{ id: '0a1b2c3d', yes: true, peer: alex.peer }]);
    room.setStatusFlags({ paused: true, roomMuted: true });
    vi.advanceTimersByTime(2100);
    alex.ballot({ yes: false });
    expect(ballots).toHaveLength(2);
    alex.presence({ proto: 2 });
    vi.advanceTimersByTime(2100);
    alex.ballot();
    expect(ballots).toHaveLength(2); // a member that needs an update is still ignored
  });

  it('accepts at most one ballot every 2 s per member, beyond the incoming limit', () => {
    profile.limit = 1;
    alex.ballot({ yes: true });
    vi.advanceTimersByTime(1000);
    alex.ballot({ yes: false });
    vi.advanceTimersByTime(1100);
    alex.ballot({ yes: false });
    expect(ballots.map((b) => b.yes)).toEqual([true, false]);
    profile.limit = 0;
    vi.advanceTimersByTime(2100);
    alex.ballot();
    alex.ballot();
    expect(ballots).toHaveLength(3); // unlimited pings do not lift the ballot limit
  });

  it('ignores a kicked peer for the rest of the session', () => {
    toasts.length = 0;
    room.kick(alex.peer);
    expect(room.state().members.map((m) => m.peer)).toEqual([SELF]);
    expect(toasts).toEqual([{ kind: 'kicked', name: 'Alex' }]);
    alex.presence({ name: 'Alex' });
    alex.text();
    expect(room.state().members).toHaveLength(1);
    expect(texts).toHaveLength(0);
    room.kick('3333333333333333'); // not a member: nothing happens
    expect(toasts).toHaveLength(1);
  });

  it('flags members on older apps and members with text or votes off', () => {
    const old = new Remote('2222222222222222', 'lan:b', lan);
    const quiet = new Remote('3333333333333333', 'lan:c', lan);
    const odd = new Remote('4444444444444444', 'lan:d', lan);
    old.presence({ app: '0.5.1' });
    quiet.presence({ app: '0.5.2', nf: ['votes'] });
    odd.presence({ app: 'room-peer', nf: ['text', 'votes'] });
    const flags = (peer: string): (boolean | undefined)[] => {
      const m = room.state().members.find((x) => x.peer === peer);
      return [m?.noChat, m?.textOff, m?.votesOff];
    };
    expect(flags(SELF)).toEqual([false, false, false]);
    expect(flags(alex.peer)).toEqual([false, false, false]);
    expect(flags(old.peer)).toEqual([true, false, false]);
    expect(flags(quiet.peer)).toEqual([false, false, true]);
    expect(flags(odd.peer)).toEqual([false, true, true]);
    quiet.presence({ app: '0.5.2' }); // switched votes back on
    expect(flags(quiet.peer)).toEqual([false, false, false]);
  });

  it('announces the switched-off room features', () => {
    const lastPresence = (): Record<string, unknown> | undefined => {
      const sent = lan.sent.filter((s) => s.to === '*').map((s) => JSON.parse(open(KEYS.msgKey, s.packet)?.toString('utf8') ?? 'null'));
      return sent.filter((m) => m?.t === 'presence').at(-1);
    };
    lan.sent = [];
    profile.nf = ['text'];
    room.profileChanged();
    expect(lastPresence()?.nf).toEqual(['text']);
    expect(room.state().members[0]).toMatchObject({ textOff: true, votesOff: false });
    lan.sent = [];
    profile.nf = [];
    room.profileChanged();
    expect(lastPresence()).toBeDefined();
    expect(lastPresence()).not.toHaveProperty('nf');
  });

  it('keeps an 0.5 peer as a member when we send text', async () => {
    const old = new Remote('2222222222222222', 'lan:b', lan);
    old.presence({ app: '0.5.1' });
    lan.sent = [];
    room.sendText('hello', { d: 1, x: 0.1, y: 0.2 });
    room.sendAlive(old.peer, { d: 1, x: 0.1, y: 0.2 });
    room.sendVote({ id: '0a1b2c3d', kind: 'kick', target: old.peer });
    room.sendBallot('0a1b2c3d', false);
    expect(sentMessages('lan:b').map((m) => m.t)).toEqual(['text', 'alive', 'vote', 'ballot']);
    expect(sentMessages('lan:b')[2]).toMatchObject({ kind: 'kick', target: old.peer });
    await vi.advanceTimersByTimeAsync(2000);
    old.presence({ app: '0.5.1' });
    expect(room.state().members.map((m) => m.peer)).toContain(old.peer);
  });

  it('sends nothing while paused', () => {
    room.setStatusFlags({ paused: true, roomMuted: false });
    lan.sent = [];
    room.sendText('hello', { d: 1, x: 0, y: 0 });
    room.sendBallot('0a1b2c3d', true);
    expect(lan.sent).toHaveLength(0);
  });
});

describe('signed members', () => {
  let sam: SignedRemote;
  const members = (): string[] => room.state().members.map((m) => m.peer);

  beforeEach(async () => {
    await joinActive();
    sam = new SignedRemote(7, 'lan:s', lan);
    sam.presence({ name: 'Sam' });
  });

  it('signs what we send with the key our presence announces, but not chunks', () => {
    room.sendToLan(sam.peer, { t: 'chunk', h: 'ab'.repeat(16), i: 0, n: 1, b: 'QQ==' });
    const sent = lan.sent.map((x) => {
      const plain = open(KEYS.msgKey, x.packet);
      if (!plain) throw new Error('unsealed');
      const d = decodeSigned(plain);
      if (!d) throw new Error('undecodable');
      return d;
    });
    const presence = sent.find((d) => d.msg.t === 'presence');
    if (!presence || presence.msg.t !== 'presence' || !presence.msg.pk || !presence.sig) throw new Error('no signed presence');
    const pk = Buffer.from(presence.msg.pk, 'base64');
    expect(peerIdOf(pk)).toBe(SELF);
    const key = publicKeyOf(pk);
    if (!key) throw new Error('bad key');
    expect(verifyBody(key, presence.body, presence.sig)).toBe(true);
    expect(sent.find((d) => d.msg.t === 'chunk')?.sig).toBeNull();
  });

  it('keeps a signed member when someone forges their bye', () => {
    lan.deliver('lan:evil', forged(sam.peer, { t: 'bye' }));
    expect(members()).toContain(sam.peer);
    sam.ping();
    expect(pings).toHaveLength(1);
  });

  it("doesn't let a forged high sequence number block a signed member", () => {
    lan.deliver('lan:evil', forged(sam.peer, { t: 'ping', ping: 'danger', d: 1, x: 0, y: 0 }, 2 ** 40));
    expect(pings).toHaveLength(0);
    sam.ping();
    expect(pings).toHaveLength(1);
  });

  it('drops a message signed with someone else’s key', () => {
    const mallory = makeIdentity(new Uint8Array(32).fill(9));
    lan.deliver('lan:evil', sam.packet({ t: 'bye' }, KEYS.msgKey, mallory));
    expect(members()).toContain(sam.peer);
    lan.deliver('lan:evil', sam.packet({ t: 'ping', ping: 'danger', d: 1, x: 0, y: 0 }, KEYS.msgKey, mallory));
    expect(pings).toHaveLength(0);
  });

  it('ignores a signed presence whose key does not match its peer id', () => {
    const liar = new SignedRemote(8, 'lan:l', lan);
    const other = makeIdentity(new Uint8Array(32).fill(10));
    const body = encodeMessage({
      peer: liar.peer, seq: 1, ts: Date.now(), t: 'presence', proto: 1, app: '0.5.2', name: 'Liar', color: 1, status: 'on',
      em: [], nf: [], pk: other.pk.toString('base64'),
    });
    lan.deliver('lan:l', seal(KEYS.msgKey, new TextEncoder().encode(joinSigned(new TextDecoder().decode(body), signBody(other, body)))));
    expect(members()).not.toContain(liar.peer);
  });

  it('drops signed messages until it has the sender’s presence', () => {
    const kim = new SignedRemote(11, 'lan:k', lan);
    kim.ping();
    expect(pings).toHaveLength(0);
    kim.presence({ name: 'Kim' });
    kim.ping();
    expect(pings).toHaveLength(1);
  });

  it('lets a signed presence win over an unsigned presence and bye sent first for the same id', () => {
    const kim = new SignedRemote(11, 'lan:k', lan);
    lan.deliver('lan:evil', forged(kim.peer, { t: 'presence', proto: 1, app: '0.5.1', name: 'Fake', color: 0, status: 'on' }));
    lan.deliver('lan:evil', forged(kim.peer, { t: 'bye' }, 2));
    kim.presence({ name: 'Kim' });
    expect(room.state().members.find((m) => m.peer === kim.peer)?.name).toBe('Kim');
    kim.ping();
    expect(pings).toHaveLength(1);
  });

  it('takes over a member that an unsigned presence made', () => {
    const kim = new SignedRemote(11, 'lan:k', lan);
    lan.deliver('lan:evil', forged(kim.peer, { t: 'presence', proto: 1, app: '0.5.1', name: 'Fake', color: 0, status: 'on' }));
    expect(room.state().members.find((m) => m.peer === kim.peer)?.name).toBe('Fake');
    kim.presence({ name: 'Kim' });
    lan.deliver('lan:evil', forged(kim.peer, { t: 'ping', ping: 'danger', d: 1, x: 0, y: 0 }, 3));
    expect(room.state().members.find((m) => m.peer === kim.peer)?.name).toBe('Kim');
    expect(pings).toHaveLength(0);
  });

  it('keeps a kicked signed member out', () => {
    room.kick(sam.peer);
    sam.presence({ name: 'Sam' });
    sam.ping();
    expect(members()).not.toContain(sam.peer);
    expect(pings).toHaveLength(0);
  });

  it('passes a chunk claiming a signed member to the transfer without moving their route', () => {
    const chunks: RoomMessage[] = [];
    room.on('chunk', (c: RoomMessage) => chunks.push(c));
    lan.deliver('lan:evil', forged(sam.peer, { t: 'chunk', h: 'cd'.repeat(16), i: 0, n: 1, b: 'QQ==' }));
    expect(chunks).toHaveLength(1);
    lan.sent.length = 0;
    room.sendToLan(sam.peer, { t: 'want', to: sam.peer, h: 'cd'.repeat(16), need: [] });
    expect(lan.sent.map((x) => x.to)).toEqual(['lan:s']);
  });
});
