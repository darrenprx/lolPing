import { createHash } from 'node:crypto';
import { type ChunkMsg, type WantMsg } from '../shared/roomProtocol';
import { checkStill } from './emoteLibrary';

/** One chunk carries this many bytes: 1,000 base64 characters, and a sealed chunk stays under the 1,200-byte packet cap. */
export const EMOTE_CHUNK_BYTES = 750;
/** Assemblies in flight at once, bytes pending in total, and how long an assembly may take. */
export const MAX_ASSEMBLIES = 16;
export const MAX_PENDING_BYTES = 256 * 1024;
export const ASSEMBLY_TIMEOUT_MS = 60_000;
/** Silence before a want for the missing indexes; at most this many re-asks, then the hash waits for the next presence. */
export const REASK_MS = 3_000;
export const REASKS_MAX = 3;
/** Chunk pacing: LAN unicast per requester per tick; over relays a chunk or a want only goes when 5 ping tokens remain. */
export const TRANSFER_TICK_MS = 100;
export const LAN_CHUNKS_PER_TICK = 2;
/** Chunks per tick across every queue and requester: the LAN egress ceiling, ~60 KB/s however many members ask. */
export const LAN_TOTAL_CHUNKS_PER_TICK = 8;
export const RELAY_KEEP_TOKENS = 5;

interface Assembly {
  /** Chunk count, from the first chunk. 0 until then: a want sent, no bytes yet. */
  n: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  firstAt: number;
  lastAt: number;
  /** The announcer our wants go to. */
  ask: string;
  /** The first want went out. Over relays it can wait for a spare ping token. */
  asked: boolean;
  reasks: number;
}

interface SendQueue {
  bytes: Uint8Array;
  n: number;
  /** LAN requesters: chunks go unicast, at most LAN_CHUNKS_PER_TICK per requester per tick. */
  lan: Map<string, Set<number>>;
  direct: Map<string, Set<number>>;
  /** Chunks that must ride a relay: one broadcast reaches the whole room, gated by the ping bucket. */
  shared: Set<number>;
}

export interface EmoteTransferDeps {
  now(): number;
  /** The still for `hash` is here already: our own library, or the cache. */
  have(hash: string): boolean;
  /** Our own still for `hash`, when it is one of our announced emotes. */
  still(hash: string): Uint8Array | null;
  /** The hashes our presence announces right now. */
  announced(): readonly string[];
  /** The Show friends' custom emotes switch. */
  enabled(): boolean;
  /** Keeps a still that passed the hash and image checks. */
  put(hash: string, bytes: Uint8Array): void;
  /** How a member is reached right now: a LAN unicast, a relay broadcast, or neither. */
  routeOf(peer: string): 'lan' | 'shared' | 'direct' | null;
  canServe?(peer: string): boolean;
  broadcastAllowed?(): boolean;
  sendDirect?(peer: string, body: Record<string, unknown>): boolean;
  sendToLan(peer: string, body: Record<string, unknown>): void;
  broadcastShared(body: Record<string, unknown>): void;
  /** True when a relay chunk may go: the shared bucket keeps `keep` tokens for pings and emotes. */
  spareSharedToken(keep: number): boolean;
}

/**
 * Moves custom emote stills over a room, both ways. The ID is the SHA-256 prefix of the still, so a finished assembly
 * that doesn't hash back to it is dropped: nobody can substitute another member's image. Bytes are only ever written to
 * the cache as `<hash>.webp` and only ever decoded by Chromium as an image; nothing here executes them.
 *
 * RoomManager emits 'emotes' (a presence's announced hashes), 'want', 'chunk' and 'memberGone'; this class answers.
 */
export class EmoteTransfer {
  private readonly announcers = new Map<string, Set<string>>();
  private readonly assemblies = new Map<string, Assembly>();
  private readonly sends = new Map<string, SendQueue>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly deps: EmoteTransferDeps) {
    this.timer = setInterval(() => this.tick(), TRANSFER_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** A presence announced `hashes`: prefetch whatever isn't here yet, on the announcer's route. */
  announced(peer: string, hashes: readonly string[]): void {
    this.announcers.set(peer, new Set(hashes));
    if (!this.deps.enabled()) return;
    for (const hash of hashes) {
      if (this.deps.have(hash) || this.assemblies.has(hash)) continue;
      if (this.assemblies.size >= MAX_ASSEMBLIES) return;
      const asked = this.sendWant(peer, hash, []);
      this.assemblies.set(hash, { n: 0, parts: new Map(), bytes: 0, firstAt: this.deps.now(), lastAt: this.deps.now(), ask: peer, asked, reasks: 0 });
    }
  }

  /** Another member asks for one of our stills. Only hashes in our own current announcement are served. */
  onWant(w: WantMsg): void {
    if (!this.deps.enabled() || this.deps.canServe?.(w.peer) === false) return;
    if (!this.deps.announced().includes(w.h)) return;
    const lane = this.deps.routeOf(w.peer);
    if (!lane) return;
    let queue = this.sends.get(w.h);
    if (!queue) {
      const bytes = this.deps.still(w.h); // read once per queue: a flood of wants can't make it read the disk each time
      if (!bytes) return;
      queue = { bytes, n: Math.ceil(bytes.length / EMOTE_CHUNK_BYTES), lan: new Map(), direct: new Map(), shared: new Set() };
      this.sends.set(w.h, queue);
    }
    const want = w.need.length > 0 ? w.need.filter((i) => i < queue.n) : Array.from({ length: queue.n }, (_, i) => i);
    if (want.length === 0) return;
    if (lane === 'lan' || lane === 'direct') {
      const map = lane === 'lan' ? queue.lan : queue.direct;
      const set = map.get(w.peer) ?? new Set<number>();
      for (const i of want) set.add(i);
      map.set(w.peer, set);
    } else {
      for (const i of want) queue.shared.add(i); // a broadcast reaches the requester as well as everyone else
    }
  }

  /** One slice of a still, from the member that announced the hash. Assemblies finish into the cache once verified. */
  onChunk(c: ChunkMsg): void {
    if (!this.deps.enabled()) return;
    if (!(this.announcers.get(c.peer)?.has(c.h) ?? false)) return; // only from a member who announced that hash
    const part = Buffer.from(c.b, 'base64');
    let a = this.assemblies.get(c.h);
    if (!a) {
      if (this.deps.have(c.h)) return; // already stored: a straggler chunk must not open a zombie assembly
      if (this.assemblies.size >= MAX_ASSEMBLIES || this.pendingBytes() + part.length > MAX_PENDING_BYTES) return;
      a = { n: 0, parts: new Map(), bytes: 0, firstAt: this.deps.now(), lastAt: this.deps.now(), ask: c.peer, asked: true, reasks: 0 };
      this.assemblies.set(c.h, a);
    }
    if (a.n === 0) a.n = c.n;
    else if (a.n !== c.n) {
      this.assemblies.delete(c.h); // one sender, two ideas about the length: drop and wait for the next presence
      return;
    }
    if (c.i >= a.n || a.parts.has(c.i)) return;
    a.parts.set(c.i, part);
    a.bytes += part.length;
    a.lastAt = this.deps.now();
    if (a.parts.size === a.n) this.finish(c.h, a);
  }

  memberGone(peer: string): void {
    this.announcers.delete(peer);
    for (const [hash, q] of this.sends) {
      q.lan.delete(peer);
      q.direct.delete(peer);
      if (q.lan.size === 0 && q.direct.size === 0 && q.shared.size === 0) this.sends.delete(hash);
    }
    for (const [hash, a] of this.assemblies) if (a.ask === peer) this.assemblies.delete(hash);
  }

  get stats(): { assembling: number; sending: number } {
    return { assembling: this.assemblies.size, sending: this.sends.size };
  }

  private pendingBytes(): number {
    let total = 0;
    for (const a of this.assemblies.values()) total += a.bytes;
    return total;
  }

  /** The finished assembly, in chunk order: kept only when it hashes back to its ID and is a still this app would import. */
  private finish(hash: string, a: Assembly): void {
    this.assemblies.delete(hash);
    const full = new Uint8Array(a.bytes);
    let at = 0;
    for (let i = 0; i < a.n; i++) {
      const part = a.parts.get(i);
      if (!part) return; // finish only runs once every index is in
      full.set(part, at);
      at += part.length;
    }
    if (createHash('sha256').update(full).digest('hex').slice(0, 32) !== hash) return;
    if (checkStill(full) !== null) return;
    this.deps.put(hash, full);
  }

  /** False when it didn't go: no route, or no spare relay token (joining a room can find 9 hashes per member at once). */
  private sendWant(peer: string, hash: string, need: readonly number[]): boolean {
    const body = { t: 'want', to: peer, h: hash, need: [...need] };
    const lane = this.deps.routeOf(peer);
    if (lane === 'direct') return this.deps.sendDirect?.(peer, body) ?? false;
    if (lane === 'lan') this.deps.sendToLan(peer, body);
    else if (lane === 'shared' && this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) this.deps.broadcastShared(body); // `to` addresses it, the seal protects it
    else return false;
    return true;
  }

  private chunkBody(hash: string, i: number, q: SendQueue): Record<string, unknown> {
    const slice = q.bytes.subarray(i * EMOTE_CHUNK_BYTES, Math.min((i + 1) * EMOTE_CHUNK_BYTES, q.bytes.length));
    return { t: 'chunk', h: hash, i, n: q.n, b: Buffer.from(slice).toString('base64') };
  }

  /** Sender pacing and receiver re-asks. Anything thrown is dropped: a timer must never take the app down. */
  private tick(): void {
    try {
      if (!this.deps.enabled()) {
        this.assemblies.clear(); // the switch stops both directions: pending work is dropped, not paused
        this.sends.clear();
        return;
      }
      let egress = 0; // chunks sent this tick, across every queue and requester
      const ours = new Set(this.deps.announced());
      for (const [hash, q] of [...this.sends]) {
        if (!ours.has(hash)) {
          this.sends.delete(hash); // the emote left our wheel: nobody may still be served it
          continue;
        }
        for (const [peer, need] of [...q.lan]) {
          if (this.deps.canServe?.(peer) === false || this.deps.broadcastAllowed?.() === false) {
            q.lan.delete(peer);
            continue;
          }
          for (let k = 0; k < LAN_CHUNKS_PER_TICK && need.size > 0 && egress < LAN_TOTAL_CHUNKS_PER_TICK; k++) {
            const i = need.values().next().value as number;
            need.delete(i);
            this.deps.sendToLan(peer, this.chunkBody(hash, i, q));
            egress++;
          }
          if (need.size === 0) q.lan.delete(peer);
        }
        for (const [peer, need] of [...q.direct]) {
          if (this.deps.canServe?.(peer) === false) { q.direct.delete(peer); continue; }
          for (let k = 0; k < LAN_CHUNKS_PER_TICK && need.size && egress < LAN_TOTAL_CHUNKS_PER_TICK; k++) {
            const i = need.values().next().value as number;
            if (!this.deps.sendDirect?.(peer, this.chunkBody(hash, i, q))) break;
            need.delete(i);
            egress++;
          }
          if (!need.size) q.direct.delete(peer);
        }
        if (this.deps.broadcastAllowed?.() === false) q.shared.clear();
        if (q.shared.size > 0 && this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) {
          const i = q.shared.values().next().value as number;
          q.shared.delete(i);
          this.deps.broadcastShared(this.chunkBody(hash, i, q));
        }
        if (q.lan.size === 0 && q.direct.size === 0 && q.shared.size === 0) this.sends.delete(hash);
      }
      const now = this.deps.now();
      for (const [hash, a] of [...this.assemblies]) {
        if (a.n > 0 && a.parts.size === a.n) continue; // completes inside onChunk
        if (now - a.firstAt >= ASSEMBLY_TIMEOUT_MS || !(this.announcers.get(a.ask)?.has(hash) ?? false)) {
          this.assemblies.delete(hash);
          continue;
        }
        if (!a.asked) {
          a.asked = this.sendWant(a.ask, hash, []);
          a.lastAt = now;
          continue;
        }
        if (now - a.lastAt < REASK_MS) continue;
        if (a.reasks >= REASKS_MAX) {
          this.assemblies.delete(hash); // the next presence starts over
          continue;
        }
        const need = a.n === 0 ? [] : Array.from({ length: a.n }, (_, i) => i).filter((i) => !a.parts.has(i));
        if (!this.sendWant(a.ask, hash, need)) continue; // waits for a token: not a re-ask yet
        a.reasks++;
        a.lastAt = now;
      }
    } catch {
      // a send that failed (a packet that wouldn't seal, a route that vanished) waits for the next tick
    }
  }
}
