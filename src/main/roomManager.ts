import type { KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EmoteRef } from '../shared/emotes';
import type { PingId } from '../shared/pings';
import type { JoinResult, MemberPath, RoomMember, RoomStateCore } from '../shared/room';
import type { TagRgb } from '../shared/roomColors';
import { formatRoomCode, makeRoomCode, parseRoomCode } from '../shared/roomCode';
import {
  decodeSigned, encodeMessage, isOlderThan, joinSigned, PROTOCOL_VERSION, ROOM_CHAT_SINCE, type BallotMsg, type MemberStatus,
  type PresenceMsg, type RoomFeatureOff, type RoomMessage, type VoteKind, type VoteMsg,
} from '../shared/roomProtocol';
import { RateLimiter } from './rateLimiter';
import { ReplayGuard } from './replayGuard';
import {
  makeIdentity, open, peerIdOf, publicKeyOf, seal, signBody, verifyBody, type RoomIdentity, type RoomKeys,
} from './roomCrypto';
import type { PeerKey, Transport, TransportStatus } from './transport';

export const MAX_MEMBERS = 16;
const SETTLE_MS = 3000;
/** Relays can take a while to answer: the "room full" check never waits longer than this after joining. */
const SETTLE_CAP_MS = 15_000;
const TICK_MS = 1000;
/** How often presence is re-announced on each transport. */
const PRESENCE_MS: Record<Transport['kind'], number> = { lan: 2000, internet: 10_000 };
/** How long a path counts as alive after the last packet over it. */
const ALIVE_MS: Record<Transport['kind'], number> = { lan: 6000, internet: 25_000 };
/** Silence before a member is dropped: longer once it was heard over the internet, where presence comes every 10 s. */
const DROP_MS: Record<Transport['kind'], number> = { lan: 15_000, internet: 30_000 };
/** Pings and emotes over relays, per sender: one publish reaches everyone, and public relays only tolerate so much (tools/relay-probe). */
export const RELAY_PING_RATE = 5;
export const RELAY_PING_BURST = 10;
/** Ballots accepted per member: one every 2 s, far below the ping limit, which only guards against floods. */
const BALLOT_RATE = 0.5;
/** want/chunk messages accepted per member: a still's chunks arrive as a burst, so this bucket is wider than the ping one. */
const TRANSFER_RATE = 60;
/** Presence asked for on a shared transport (a change, a new link, a new member): at most this often. */
const SHARED_PRESENCE_MS = 1000;
/** The first app version that shows emotes. */
const EMOTES_SINCE = '0.5.0';
const UNREACHABLE_MS = 20_000;
const LONELY_MS = 20_000;
const STALE_STRIKES = 3;
/** A housekeeping tick this late means the computer slept: nobody was heard because we weren't listening. */
const SLEEP_GAP_MS = 5000;
/** How long the clock warning stays up after the last stale presence. */
const SKEW_HINT_MS = 30_000;

/** A member's name tag as it reaches the overlay: a palette index, plus the exact colour when it is a custom one. */
export interface MemberTag {
  name: string;
  color: number;
  rgb: TagRgb | null;
}

export interface RemotePing {
  displayId: number;
  x: number;
  y: number;
  id: PingId;
  tag: MemberTag;
}

export interface RemoteEmote {
  displayId: number;
  x: number;
  y: number;
  ref: EmoteRef;
  /** The sender's chosen effect for a custom emote; undefined is the plain pop (an app before 0.5.2, or none stored). */
  fx?: number;
  /** The sender, so their earlier emote can be replaced: everyone has one on screen at a time. */
  peer: string;
  tag: MemberTag;
}

/** A line a member posted: `text` carries `text`; `alive` carries `who`, the member they clicked in the panel. */
export interface RemoteText {
  kind: 'text' | 'alive';
  /** The sender. */
  peer: string;
  tag: MemberTag;
  displayId: number;
  x: number;
  y: number;
  text?: string;
  who?: string;
}

export type RoomToast =
  | { kind: 'joined' | 'left' | 'disconnected' | 'kicked'; name: string }
  | { kind: 'joinedRoom'; code: string }
  | { kind: 'full' };

export interface RoomDeps {
  transports: Transport[];
  now(): number;
  randomBytes(n: number): Uint8Array;
  deriveKeys(canonical: string): Promise<RoomKeys>;
  appVersion: string;
  /**
   * Read on every use, so settings changes apply at once. `limit`: incoming pings per second per member, 0 = unlimited.
   * `nf`: the room features we have switched off, announced in our presence.
   */
  profile(): { name: string; color: number; rgb: TagRgb | null; limit: number; nf: RoomFeatureOff[] };
  /** Display number → where a ping for it lands here, or null to drop it. The hook share mode will replace. */
  resolveTarget(d: number): { displayId: number; width: number; height: number } | null;
  /** The 32-hex hashes our presence announces: the custom emotes on our wheel and centre. Read on every presence. */
  announceEmotes(): readonly string[];
}

interface Member {
  peer: string;
  name: string;
  color: number;
  rgb: TagRgb | null;
  status: MemberStatus;
  needsUpdate: boolean;
  noEmotes: boolean;
  noChat: boolean;
  textOff: boolean;
  votesOff: boolean;
  muted: boolean;
  /** The custom emote hashes their last presence announced. */
  em: string[];
  firstSeen: number;
  /** Ever heard over the internet: dropped after the longer silence. */
  viaInternet: boolean;
  /** Per transport kind: the address it was last heard from, and when. */
  paths: Partial<Record<Transport['kind'], { key: PeerKey; seenAt: number }>>;
  /** The key their signed presence proved; null for a member on 0.5.1 or older, who signs nothing. */
  pk: KeyObject | null;
}

/**
 * The room: who is in it, what we send, and what we let through. Talks to the network only through transports,
 * which carry sealed packets. Events: 'state' (RoomStateCore), 'remotePing' (RemotePing), 'remoteEmote' (RemoteEmote), 'toast' (RoomToast),
 * 'remoteText' (RemoteText: text and alive lines), 'vote' (VoteMsg), 'ballot' (BallotMsg), 'saveCode' (canonical code | null: what "rejoin last room" should remember), 'emotes' (peer, announced hashes),
 * 'want' (WantMsg), 'chunk' (ChunkMsg) and 'memberGone' (peer), which EmoteTransfer answers.
 */
export class RoomManager extends EventEmitter {
  /**
   * Our peer ID: the hash of a key made fresh on every join, since a peer that said bye stays "gone" to the others for
   * their whole session, and because only the holder of that key can sign as this ID.
   */
  self: string;
  private identity: RoomIdentity;
  private phase: RoomStateCore['phase'] = 'idle';
  private code: string | null = null;
  private keys: RoomKeys | null = null;
  /** Bumped on every join and leave, so a join still deriving keys can tell it was cancelled. */
  private session = 0;
  private seq = 0;
  private members = new Map<string, Member>();
  private answered = new Set<PeerKey>();
  /** Per peer ID: stale presences seen, and when the last one came. Never turns into a member. */
  private staleStrikes = new Map<string, { count: number; at: number }>();
  /** Signed and unsigned traffic are judged apart, so nothing unsigned can block or remove a member who signs. */
  private signedGuard: ReplayGuard;
  private unsignedGuard: ReplayGuard;
  /** Every ID a signed presence has proved this session: unsigned packets claiming one are forgeries. */
  private boundIds = new Set<string>();
  private readonly limiter: RateLimiter;
  /** Emote stills (want/chunk) per member: their own, wider bucket, so a flood of wants still meets a wall. */
  private readonly transferLimiter: RateLimiter;
  /** Ballots per member, apart from `limiter`: a vote needs every answer, but not a flood of them. */
  private readonly ballotLimiter: RateLimiter;
  private paused = false;
  private roomMuted = false;
  private aloneSince: number | null = null;
  private lastPresence: Partial<Record<Transport['kind'], number>> = {};
  private ticker: NodeJS.Timeout | null = null;
  private lastTick = 0;
  /** When we last woke from sleep: members count as heard then, so they get a fresh grace period. */
  private wokeAt = 0;
  private settle: NodeJS.Timeout | null = null;
  /** The settle timer has been cut down from the cap to SETTLE_MS. */
  private settleShort = false;
  private joinedAt = 0;
  private lastState = '';
  private internetAllowed = true;
  /** The transports running for this room: all of them, except the internet one while it isn't allowed. */
  private readonly active = new Set<Transport>();
  private readonly relayCap: RateLimiter;
  /** A presence waiting out SHARED_PRESENCE_MS, per shared transport. */
  private readonly sharedTimers = new Map<Transport, NodeJS.Timeout>();

  constructor(private readonly deps: RoomDeps) {
    super();
    this.identity = makeIdentity(deps.randomBytes(32));
    this.self = peerIdOf(this.identity.pk);
    this.signedGuard = new ReplayGuard(deps.now);
    this.unsignedGuard = new ReplayGuard(deps.now);
    this.limiter = new RateLimiter(deps.now);
    this.transferLimiter = new RateLimiter(deps.now);
    this.ballotLimiter = new RateLimiter(deps.now);
    this.relayCap = new RateLimiter(deps.now);
    for (const t of deps.transports) {
      t.on('packet', (peer: PeerKey, packet: Uint8Array) => this.onPacket(t, peer, packet));
      t.on('peerGone', (peer: PeerKey) => this.onPeerGone(t, peer));
      t.on('status', (s: TransportStatus) => {
        // A fresh socket: tell everyone now rather than at the next round. Relays say so per relay, with linkUp.
        if (s === 'ok' && !t.shared) this.announce(t);
        this.checkSettle();
        this.emitState();
      });
      t.on('linkUp', () => this.announce(t));
    }
  }

  async create(): Promise<void> {
    await this.start(makeRoomCode(this.deps.randomBytes(9)));
  }

  async join(text: string): Promise<JoinResult> {
    const parsed = parseRoomCode(text);
    if (!parsed.ok) return parsed;
    return (await this.start(parsed.code)) ? { ok: true } : { ok: false, error: 'failed' };
  }

  /** Leaves the room and forgets it, so it isn't rejoined on the next launch. */
  leave(): void {
    if (this.phase === 'idle') return;
    this.stop();
    this.emit('saveCode', null);
  }

  /** Says bye on the way out, but keeps the code for "rejoin last room". */
  quit(): void {
    if (this.phase !== 'idle') this.stop();
  }

  sendPing(ping: PingId, shared: { d: number; x: number; y: number }): void {
    this.sendShared({ t: 'ping', ping, ...shared });
  }

  /** `fx` is the effect stored on the emote's entry here; absent (the plain pop) leaves the field out for the older peers. */
  sendEmote(e: EmoteRef, shared: { d: number; x: number; y: number }, fx?: number): void {
    this.sendShared({ t: 'emote', e, ...shared, ...(fx !== undefined ? { fx } : {}) });
  }

  sendText(text: string, shared: { d: number; x: number; y: number }): void {
    this.sendShared({ t: 'text', text, ...shared });
  }

  /** `who` is the member whose name the line shows; the receivers write the words themselves. */
  sendAlive(who: string, shared: { d: number; x: number; y: number }): void {
    this.sendShared({ t: 'alive', who, ...shared });
  }

  sendVote(v: { id: string; kind: VoteKind; target?: string }): void {
    this.sendShared({ t: 'vote', ...v });
  }

  sendBallot(id: string, yes: boolean): void {
    this.sendShared({ t: 'ballot', id, yes });
  }

  /** Removes a member and ignores that peer ID for the rest of the session, as if it had said bye. */
  kick(peer: string): void {
    const m = this.members.get(peer);
    if (!m) return;
    this.signedGuard.markGone(peer);
    this.unsignedGuard.markGone(peer);
    this.remove(m, 'kicked');
  }

  /** A ping, an emote, text or a vote message: each member gets it over its own route; shared transports get one send, within the relay cap. */
  private sendShared(body: Record<string, unknown>): void {
    if (this.phase === 'idle' || !this.keys || this.paused) return;
    const packet = this.seal(body);
    const sharedRoutes = new Set<Transport>();
    for (const m of this.members.values()) {
      const route = this.route(m);
      if (!route) continue;
      if (route.transport.shared) sharedRoutes.add(route.transport);
      else route.transport.sendTo(route.key, packet);
    }
    for (const t of sharedRoutes) if (this.relayCap.allow(t.kind, RELAY_PING_RATE, RELAY_PING_BURST)) t.broadcast(packet);
  }

  /** How a member is reached right now, for emote transfers: cheap LAN unicast, one-cast-reaches-all relays, or neither. */
  routeKind(peer: string): 'lan' | 'shared' | null {
    const m = this.members.get(peer);
    const route = m && this.route(m);
    if (!route) return null;
    return route.transport.shared ? 'shared' : 'lan';
  }

  /** Seals and sends `body` straight to one member over its LAN path. Nothing goes when LAN isn't what reaches them. */
  sendToLan(peer: string, body: Record<string, unknown>): void {
    if (this.phase === 'idle' || !this.keys) return;
    const m = this.members.get(peer);
    const route = m && this.route(m);
    if (!route || route.transport.shared) return;
    try {
      route.transport.sendTo(route.key, this.seal(body));
    } catch {
      // a body that wouldn't fit the packet cap is dropped; the sender's next want or tick retries
    }
  }

  /** One sealed broadcast on every shared transport: a relay reaches the whole room. Chunk pacing is the caller's job. */
  broadcastShared(body: Record<string, unknown>): void {
    if (this.phase === 'idle' || !this.keys) return;
    try {
      const packet = this.seal(body);
      for (const t of this.active) if (t.shared) t.broadcast(packet);
    } catch {
      // dropped, as above
    }
  }

  /** True when the shared bucket can spend a token on a chunk and still keep `keep` for pings and emotes. */
  spareSharedToken(keep: number): boolean {
    if (this.phase === 'idle' || !this.keys) return false;
    if (this.relayCap.tokens('internet', RELAY_PING_RATE, RELAY_PING_BURST) < keep + 1) return false;
    return this.relayCap.allow('internet', RELAY_PING_RATE, RELAY_PING_BURST);
  }

  setStatusFlags(f: { paused: boolean; roomMuted: boolean }): void {
    if (f.paused === this.paused && f.roomMuted === this.roomMuted) return;
    this.paused = f.paused;
    this.roomMuted = f.roomMuted;
    this.announce();
    this.emitState();
  }

  muteMember(peer: string, on: boolean): void {
    const m = this.members.get(peer);
    if (!m) return;
    m.muted = on;
    this.emitState();
  }

  /**
   * "Allow internet connections". Turning it off mid-room sends no bye: a bye makes the others ignore our peer ID for
   * their whole session, LAN included. Members only reachable over the internet time out instead.
   */
  setInternetAllowed(on: boolean): void {
    if (on === this.internetAllowed) return;
    this.internetAllowed = on;
    const keys = this.keys;
    if (!keys) return; // idle, or still deriving keys: start() reads the flag
    for (const t of this.deps.transports) {
      if (t.kind !== 'internet') continue;
      if (on) {
        this.active.add(t);
        t.start(keys);
        this.announce(t);
        continue;
      }
      this.active.delete(t);
      this.cancelShared(t);
      t.stop();
      for (const m of this.members.values()) {
        const p = m.paths.internet;
        if (!p) continue;
        this.answered.delete(p.key);
        delete m.paths.internet;
      }
    }
    this.checkSettle();
    this.emitState();
  }

  /** Name or colour changed: tell everyone now. */
  profileChanged(): void {
    this.announce();
    this.emitState();
  }

  state(): RoomStateCore {
    const now = this.deps.now();
    const status = (kind: Transport['kind']): TransportStatus =>
      this.phase === 'idle' ? 'off' : ([...this.active].find((t) => t.kind === kind)?.status ?? 'off');
    const p = this.deps.profile();
    const members: RoomMember[] = this.phase === 'idle' ? [] : [
      {
        peer: this.self, name: p.name, color: p.color, rgb: p.rgb, path: 'lan', status: this.status(),
        needsUpdate: false, noEmotes: false, noChat: false, textOff: p.nf.includes('text'), votesOff: p.nf.includes('votes'),
        muted: false, self: true,
      },
      ...[...this.members.values()].map((m) => ({
        peer: m.peer, name: m.name, color: m.color, rgb: m.rgb, path: this.path(m, now), status: m.status,
        needsUpdate: m.needsUpdate, noEmotes: m.noEmotes, noChat: m.noChat, textOff: m.textOff, votesOff: m.votesOff,
        muted: m.muted, self: false,
      })),
    ];
    return {
      phase: this.phase,
      code: this.code ? formatRoomCode(this.code) : null,
      members,
      lan: status('lan'),
      internet: status('internet'),
      lonely: this.aloneSince !== null && now - this.aloneSince >= LONELY_MS,
      clockSkew: [...this.staleStrikes.values()].some((s) => s.count >= STALE_STRIKES && now - s.at < SKEW_HINT_MS),
    };
  }

  /** False when the keys couldn't be derived: the room is back to idle. */
  private async start(code: string): Promise<boolean> {
    if (this.phase !== 'idle') this.leave();
    const session = ++this.session;
    this.identity = makeIdentity(this.deps.randomBytes(32));
    this.self = peerIdOf(this.identity.pk);
    this.seq = 0;
    this.phase = 'joining';
    this.code = code;
    this.signedGuard = new ReplayGuard(this.deps.now);
    this.unsignedGuard = new ReplayGuard(this.deps.now);
    this.boundIds = new Set();
    this.aloneSince = this.deps.now();
    this.emitState();
    let keys: RoomKeys;
    try {
      keys = await this.deps.deriveKeys(code);
    } catch {
      if (session === this.session) this.stop();
      return false;
    }
    if (session !== this.session) return true; // left while deriving
    this.keys = keys;
    this.joinedAt = this.lastTick = this.deps.now();
    this.settleShort = false;
    this.settle = setTimeout(() => this.settled(), SETTLE_CAP_MS);
    for (const t of this.deps.transports) if (t.kind !== 'internet' || this.internetAllowed) this.active.add(t);
    for (const t of this.active) t.start(keys);
    this.announce();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.checkSettle();
    this.emitState();
    return true;
  }

  /**
   * "Room full" is judged 3 s after the relays have answered or given up, so members only reachable over the
   * internet count too; never later than SETTLE_CAP_MS after joining.
   */
  private checkSettle(): void {
    if (this.phase !== 'joining' || !this.settle || this.settleShort) return;
    if ([...this.active].some((t) => t.shared && (t.status === 'off' || t.status === 'starting'))) return;
    this.settleShort = true;
    clearTimeout(this.settle);
    this.settle = setTimeout(() => this.settled(), Math.min(SETTLE_MS, this.joinedAt + SETTLE_CAP_MS - this.deps.now()));
  }

  private settled(): void {
    this.settle = null;
    if (this.members.size >= MAX_MEMBERS) {
      this.stop();
      this.emit('toast', { kind: 'full' } satisfies RoomToast);
      return;
    }
    this.phase = 'active';
    this.emit('saveCode', this.code);
    this.emit('toast', { kind: 'joinedRoom', code: formatRoomCode(this.code!) } satisfies RoomToast);
    this.emitState();
  }

  private stop(): void {
    this.session++;
    if (this.keys) {
      const bye = this.seal({ t: 'bye' });
      for (const t of this.active) this.spread(t, bye);
      for (const t of this.active) t.stop();
    }
    this.active.clear();
    for (const t of [...this.sharedTimers.keys()]) this.cancelShared(t);
    if (this.ticker) clearInterval(this.ticker);
    if (this.settle) clearTimeout(this.settle);
    this.ticker = this.settle = null;
    this.phase = 'idle';
    this.code = this.keys = null;
    for (const m of this.members.keys()) this.emit('memberGone', m);
    this.members.clear();
    this.limiter.clear();
    this.transferLimiter.clear();
    this.ballotLimiter.clear();
    this.answered.clear();
    this.staleStrikes.clear();
    this.lastPresence = {};
    this.aloneSince = null;
    this.emitState();
  }

  private tick(): void {
    const now = this.deps.now();
    if (now - this.lastTick > SLEEP_GAP_MS) this.wokeAt = now;
    this.lastTick = now;
    for (const [peer, s] of this.staleStrikes) if (now - s.at >= SKEW_HINT_MS) this.staleStrikes.delete(peer);
    for (const m of [...this.members.values()]) {
      const heard = Math.max(...Object.values(m.paths).map((p) => p.seenAt), m.firstSeen, this.wokeAt);
      if (now - heard >= DROP_MS[m.viaInternet ? 'internet' : 'lan']) this.remove(m, 'disconnected');
    }
    for (const t of this.active) {
      if (now - (this.lastPresence[t.kind] ?? 0) >= PRESENCE_MS[t.kind]) this.sendPresence(t);
    }
    this.emitState();
  }

  private onPacket(t: Transport, key: PeerKey, packet: Uint8Array): void {
    if (!this.keys) return;
    const plain = open(this.keys.msgKey, packet);
    const decoded = plain && decodeSigned(plain);
    if (!decoded || decoded.msg.peer === this.self) return;
    const { msg, body, sig } = decoded;
    // Chunks are never signed (a signature wouldn't fit), and needn't be: a still is checked against its hash when
    // assembled. So whoever a chunk claims to be from, it never moves a replay window, a liveness clock or a route.
    if (msg.t === 'chunk') {
      const m = this.members.get(msg.peer);
      if (!m || this.paused || m.muted || m.needsUpdate || !this.transferLimiter.allow(m.peer, TRANSFER_RATE)) return;
      this.emit('chunk', msg);
      return;
    }
    let pk: KeyObject | null = null;
    if (sig) {
      pk = msg.t === 'presence' ? this.provenKey(msg) : this.members.get(msg.peer)?.pk ?? null;
      if (!pk || !verifyBody(pk, body, sig)) return;
    } else if (this.boundIds.has(msg.peer)) {
      return;
    }
    const guard = sig ? this.signedGuard : this.unsignedGuard;
    const verdict = guard.accept(msg.peer, msg.seq, msg.ts);
    if (verdict === 'stale') return this.onStale(msg);
    if (verdict !== 'ok') return;
    this.staleStrikes.delete(msg.peer);

    if (msg.t === 'presence') return this.onPresence(t, key, msg, pk);
    const m = this.members.get(msg.peer);
    if (msg.t === 'bye') {
      guard.markGone(msg.peer);
      if (m) this.remove(m, 'left');
      return;
    }
    if (!m) return;
    this.heard(m, t, key);
    // Emote still requests travel in their own bucket: a flood of wants still meets a wall. A paused lolPing neither
    // fetches nor serves stills. An app on another protocol generation can't have sent these (its validator drops
    // unknown types), so that check is defence in depth.
    if (msg.t === 'want') {
      if (this.paused || m.muted || m.needsUpdate || msg.to !== this.self) return;
      if (!this.transferLimiter.allow(m.peer, TRANSFER_RATE)) return;
      this.emit('want', msg);
      return;
    }
    // A ballot is the one answer a vote waits for, so a muted member's still counts and so does our own pause;
    // the vote unit decides. Only a member we can't read, and a ballot flood, are shut out.
    if (msg.t === 'ballot') {
      if (m.needsUpdate || !this.ballotLimiter.allow(m.peer, BALLOT_RATE, 1)) return;
      this.emit('ballot', msg satisfies BallotMsg);
      return;
    }
    // Pings, emotes, text, alive lines and votes pass the same gates and share one budget per member.
    if (this.paused || this.roomMuted || m.muted || m.needsUpdate) return;
    if (!this.limiter.allow(m.peer, this.deps.profile().limit)) return;
    if (msg.t === 'vote') {
      this.emit('vote', msg satisfies VoteMsg);
      return;
    }
    if (msg.t === 'alive' && msg.who !== this.self && !this.members.has(msg.who)) return;
    const target = this.deps.resolveTarget(msg.d);
    if (!target) return;
    const [x, y] = [msg.x * target.width, msg.y * target.height];
    const tag: MemberTag = { name: m.name, color: m.color, rgb: m.rgb };
    if (msg.t === 'ping') this.emit('remotePing', { displayId: target.displayId, x, y, id: msg.ping, tag } satisfies RemotePing);
    else if (msg.t === 'emote') this.emit('remoteEmote', { displayId: target.displayId, x, y, ref: msg.e, fx: msg.fx, peer: m.peer, tag } satisfies RemoteEmote);
    else if (msg.t === 'text') {
      this.emit('remoteText', { kind: 'text', peer: m.peer, tag, displayId: target.displayId, x, y, text: msg.text } satisfies RemoteText);
    } else if (msg.t === 'alive') {
      this.emit('remoteText', { kind: 'alive', peer: m.peer, tag, displayId: target.displayId, x, y, who: msg.who } satisfies RemoteText);
    }
  }

  /** The key a signed presence carries, when its peer ID is that key's hash; null when it can't vouch for the ID. */
  private provenKey(msg: PresenceMsg): KeyObject | null {
    if (!msg.pk) return null;
    const raw = Buffer.from(msg.pk, 'base64');
    return peerIdOf(raw) === msg.peer ? publicKeyOf(raw) : null;
  }

  /** `pk` is the key a signed presence proved, null for an unsigned one; it takes over a member an unsigned one made. */
  private onPresence(t: Transport, key: PeerKey, msg: PresenceMsg, pk: KeyObject | null): void {
    let m = this.members.get(msg.peer);
    const isNew = !m;
    if (!m) {
      // The room cap is judged here too, not only at settle: without this, anyone can grow the room past
      // MAX_MEMBERS afterwards, and every extra "member" earns its own emote-chunk serving quota. We are one of them.
      if (this.phase === 'active' && this.members.size + 1 >= MAX_MEMBERS) return;
      // One LAN address is one lolPing: two members behind it is a rebound, a third is forgery. Shared transports
      // can't be judged this way (every relay member arrives from the same key).
      if (!t.shared && this.membersAt(t.kind, key) >= 2) return;
      m = {
        peer: msg.peer, name: msg.name, color: msg.color, rgb: msg.rgb ?? null, status: msg.status,
        needsUpdate: false, noEmotes: false, noChat: false, textOff: false, votesOff: false, muted: false, em: [],
        firstSeen: this.deps.now(), viaInternet: false, paths: {}, pk: null,
      };
      this.members.set(m.peer, m);
      this.aloneSince = null;
    }
    if (pk) {
      m.pk = pk;
      this.boundIds.add(m.peer);
    }
    m.name = msg.name;
    m.color = msg.color;
    m.rgb = msg.rgb ?? null;
    m.status = msg.status;
    m.needsUpdate = msg.proto !== PROTOCOL_VERSION;
    m.noEmotes = isOlderThan(msg.app, EMOTES_SINCE);
    m.noChat = isOlderThan(msg.app, ROOM_CHAT_SINCE);
    m.textOff = msg.nf.includes('text');
    m.votesOff = msg.nf.includes('votes');
    m.em = msg.em;
    // Every presence, so a hash whose assembly gave up is asked for again: EmoteTransfer skips what is already here.
    // A paused lolPing neither fetches nor serves stills; the next presence after unpausing starts prefetch again.
    if (!this.paused) this.emit('emotes', m.peer, [...m.em]);
    this.heard(m, t, key);
    if (!this.answered.has(key)) {
      this.answered.add(key);
      if (t.shared) this.announce(t); // everyone hears it anyway, so it's an ordinary presence
      else t.sendTo(key, this.presencePacket());
    }
    if (isNew && this.phase === 'active') this.emit('toast', { kind: 'joined', name: m.name } satisfies RoomToast);
    this.emitState();
  }

  /**
   * Packets more than 10 minutes off our clock. Anyone on the network can replay old ones, so they never create,
   * refresh or reach a member; a few presences only raise the room-level clock warning.
   */
  private onStale(msg: RoomMessage): void {
    if (msg.t !== 'presence') return;
    const s = this.staleStrikes.get(msg.peer) ?? { count: 0, at: 0 };
    this.staleStrikes.set(msg.peer, { count: s.count + 1, at: this.deps.now() });
    this.emitState();
  }

  private onPeerGone(t: Transport, key: PeerKey): void {
    for (const m of this.members.values()) if (m.paths[t.kind]?.key === key) delete m.paths[t.kind];
    this.answered.delete(key);
    this.emitState();
  }

  private heard(m: Member, t: Transport, key: PeerKey): void {
    m.paths[t.kind] = { key, seenAt: this.deps.now() };
    if (t.kind === 'internet') m.viaInternet = true;
  }

  private remove(m: Member, kind: 'left' | 'disconnected' | 'kicked'): void {
    this.members.delete(m.peer);
    this.limiter.forget(m.peer);
    this.ballotLimiter.forget(m.peer);
    this.transferLimiter.forget(m.peer);
    for (const p of Object.values(m.paths)) this.answered.delete(p.key);
    if (this.members.size === 0 && this.phase !== 'idle') this.aloneSince = this.deps.now();
    this.emit('memberGone', m.peer);
    this.emit('toast', { kind, name: m.name } satisfies RoomToast);
    this.emitState();
  }

  /** Members last heard from one transport-local address. */
  private membersAt(kind: Transport['kind'], key: PeerKey): number {
    return [...this.members.values()].filter((m) => m.paths[kind]?.key === key).length;
  }

  /** LAN while it is alive, else internet, else nothing. */
  private route(m: Member): { transport: Transport; key: PeerKey } | null {
    const now = this.deps.now();
    for (const kind of ['lan', 'internet'] as const) {
      const p = m.paths[kind];
      const transport = [...this.active].find((t) => t.kind === kind);
      if (p && transport && now - p.seenAt < ALIVE_MS[kind]) return { transport, key: p.key };
    }
    return null;
  }

  private path(m: Member, now: number): MemberPath {
    const r = this.route(m);
    if (r) return r.transport.kind;
    return now - m.firstSeen < UNREACHABLE_MS ? 'connecting' : 'unreachable';
  }

  private status(): MemberStatus {
    return this.paused ? 'paused' : this.roomMuted ? 'muted' : 'on';
  }

  private presencePacket(): Buffer {
    const p = this.deps.profile();
    return this.seal({
      t: 'presence', proto: PROTOCOL_VERSION, app: this.deps.appVersion, name: p.name, color: p.color, status: this.status(),
      em: [...this.deps.announceEmotes()], pk: this.identity.pk.toString('base64'),
      // Left out when nothing is off, so a presence to an older peer carries nothing new.
      ...(p.nf.length ? { nf: [...p.nf] } : {}),
      // Left out rather than sent as null: a peer on an older build ignores it either way, and this keeps the packet small.
      ...(p.rgb ? { rgb: p.rgb } : {}),
    });
  }

  /**
   * Presence on one transport, or on every running one. A shared transport sends at most once a second: the first
   * request goes out at once, later ones in that second become one presence at its end, with the latest state.
   */
  private announce(only?: Transport): void {
    if (!this.keys) return;
    for (const t of only ? [only] : [...this.active]) {
      if (!this.active.has(t)) continue;
      if (!t.shared) {
        this.sendPresence(t);
        continue;
      }
      const wait = (this.lastPresence[t.kind] ?? -Infinity) + SHARED_PRESENCE_MS - this.deps.now();
      if (wait <= 0) this.sendPresence(t);
      else if (!this.sharedTimers.has(t)) {
        this.sharedTimers.set(t, setTimeout(() => {
          this.sharedTimers.delete(t);
          if (this.keys && this.active.has(t)) this.sendPresence(t);
        }, wait));
      }
    }
  }

  private sendPresence(t: Transport): void {
    this.cancelShared(t);
    this.spread(t, this.presencePacket());
    this.lastPresence[t.kind] = this.deps.now();
  }

  private cancelShared(t: Transport): void {
    const timer = this.sharedTimers.get(t);
    if (timer) clearTimeout(timer);
    this.sharedTimers.delete(t);
  }

  /**
   * Broadcast, and on LAN also straight to every member heard there: Wi-Fi broadcast has no retries and some
   * routers filter it, unicast doesn't. Duplicates are dropped by the receiver's replay guard.
   */
  private spread(t: Transport, packet: Uint8Array): void {
    t.broadcast(packet);
    if (t.shared) return; // one send already reached everyone
    for (const m of this.members.values()) {
      const key = m.paths.lan?.key;
      if (key) t.sendTo(key, packet);
    }
  }

  private seal(body: Record<string, unknown>): Buffer {
    const msg = { peer: this.self, seq: ++this.seq, ts: this.deps.now(), ...body } as RoomMessage;
    const bytes = encodeMessage(msg);
    if (msg.t === 'chunk') return seal(this.keys!.msgKey, bytes);
    const signed = joinSigned(new TextDecoder().decode(bytes), signBody(this.identity, bytes));
    return seal(this.keys!.msgKey, new TextEncoder().encode(signed));
  }

  private emitState(): void {
    const s = this.state();
    const json = JSON.stringify(s);
    if (json === this.lastState) return;
    this.lastState = json;
    this.emit('state', s);
  }
}
