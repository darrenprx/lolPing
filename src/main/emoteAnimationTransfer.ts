import { createHash } from 'node:crypto';
import { ANIM_MAX_BYTES, customAnimUrl } from '../shared/emotes';
import { sniffImage } from '../shared/imageSniff';
import {
  ANIMATION_CHUNK_BYTES, ANIMATION_WINDOW, type AnimationChunkMsg, type AnimationInfo,
  type AnimationInfoMsg, type AnimationWantMsg,
} from '../shared/roomProtocol';
import { checkAnim } from './emoteLibrary';

export const ANIMATION_TRANSFERS_MAX = 2;
// Two full-sized originals can share one peer's pacing budget for more than five minutes.
export const ANIMATION_TIMEOUT_MS = 10 * 60_000;
export const ANIMATION_RETRY_MS = 3000;
export const ANIMATION_TICK_MS = 100;
/** Leave headroom below the existing 100 packets/s per-IP flood guard for stills, pings and presence. */
export const ANIMATION_CHUNKS_PER_PEER = 6;
export const ANIMATION_CHUNKS_PER_TICK = 12;
const RETRIES = 3;
const METADATA_REFRESH_MS = 10_000;

interface Download {
  firstAt: number;
  lastAt: number;
  retries: number;
  bytes: Uint8Array | null;
  cursor: number;
  need: Set<number>;
  saving: boolean;
}

interface Entry {
  info: AnimationInfo | null | undefined;
  refreshAt: number;
  download?: Download;
}

interface Source {
  info: AnimationInfo;
  bytes: Uint8Array;
}

interface SendQueue {
  peer: string;
  h: string;
  source: Source;
  need: Set<number>;
  at: number;
}

export interface EmoteAnimationTransferDeps {
  now(): number;
  enabled(): boolean;
  /** A live, unmuted LAN member who advertised signed animation support. */
  canPeer(peer: string): boolean;
  announced(): readonly string[];
  animation(hash: string): Promise<Uint8Array | null>;
  have(hash: string): boolean;
  put(hash: string, bytes: Uint8Array): Promise<boolean>;
  touch(hash: string): void;
  send(peer: string, body: Record<string, unknown>): void;
}

/** Optional LAN-only originals. Stills keep their existing transfer, cache and old-peer fallback. */
export class EmoteAnimationTransfer {
  private readonly peers = new Map<string, Map<string, Entry>>();
  private readonly sends = new Map<string, SendQueue>();
  private readonly sources = new Map<string, { promise: Promise<Source | null>; loaded: boolean }>();
  private readonly timer: NodeJS.Timeout;
  private generation = 0;

  constructor(private readonly deps: EmoteAnimationTransferDeps) {
    this.timer = setInterval(() => this.tick(), ANIMATION_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.reset();
    this.peers.clear();
  }

  /** Imports can replace an original under the same still hash. Do not serve the earlier bytes. */
  invalidateSources(): void {
    this.generation++;
    this.sources.clear();
    this.sends.clear();
  }

  announced(peer: string, hashes: readonly string[]): void {
    const previous = this.peers.get(peer);
    this.peers.set(peer, new Map(hashes.map((h) => [h, previous?.get(h) ?? { info: undefined, refreshAt: 0 }])));
  }

  memberGone(peer: string): void {
    this.peers.delete(peer);
    for (const [key, q] of this.sends) if (q.peer === peer) this.sends.delete(key);
  }

  /** Only this sender's signed binding can select the animation; another local import is never substituted. */
  url(peer: string, hash: string): string | null {
    if (!this.allowed(peer)) return null;
    const info = this.peers.get(peer)?.get(hash)?.info;
    if (!info || !this.deps.have(info.a)) return null;
    this.deps.touch(info.a);
    return customAnimUrl(info.a);
  }

  async onWant(w: AnimationWantMsg): Promise<void> {
    if (!this.allowed(w.peer) || !this.deps.announced().includes(w.h)) return;
    const generation = this.generation;
    const pending = this.source(w.h);
    if (!pending) return; // busy: the requester's bounded retry will ask later
    const source = await pending;
    if (generation !== this.generation || !this.allowed(w.peer) || !this.deps.announced().includes(w.h)) return;
    if (!w.a) {
      this.deps.send(w.peer, { t: 'anim-info', to: w.peer, h: w.h, info: source?.info ?? null });
      return;
    }
    if (!source || source.info.a !== w.a || !w.need) return;
    const key = `${w.peer}:${w.h}`;
    const old = this.sends.get(key);
    if (!old && this.sends.size >= ANIMATION_TRANSFERS_MAX) return;
    const count = Math.ceil(source.bytes.length / ANIMATION_CHUNK_BYTES);
    const need = new Set(old?.source.info.a === w.a ? old.need : []);
    for (const i of w.need) if (i < count && need.size < ANIMATION_WINDOW) need.add(i);
    if (need.size > 0) this.sends.set(key, { peer: w.peer, h: w.h, source, need, at: this.deps.now() });
  }

  onInfo(m: AnimationInfoMsg): void {
    if (!this.allowed(m.peer)) return;
    const entry = this.peers.get(m.peer)?.get(m.h);
    if (!entry?.download || entry.download.bytes || entry.download.saving) return;
    entry.info = m.info;
    entry.refreshAt = this.deps.now() + METADATA_REFRESH_MS;
    if (!m.info || this.deps.have(m.info.a)) {
      delete entry.download;
      return;
    }
    entry.download.bytes = new Uint8Array(m.info.size);
    this.requestWindow(m.peer, m.h, entry);
  }

  onChunk(c: AnimationChunkMsg): void {
    if (!this.allowed(c.peer)) return;
    const entry = this.peers.get(c.peer)?.get(c.h);
    const d = entry?.download;
    if (!entry?.info || entry.info.a !== c.a || !d?.bytes || d.saving || !d.need.has(c.i)) return;
    const part = Buffer.from(c.b, 'base64');
    const offset = c.i * ANIMATION_CHUNK_BYTES;
    const expected = Math.min(ANIMATION_CHUNK_BYTES, d.bytes.length - offset);
    if (part.length !== expected) return;
    d.bytes.set(part, offset);
    d.need.delete(c.i);
    d.lastAt = this.deps.now();
    if (d.need.size > 0) return;
    d.cursor = Math.min(d.cursor + ANIMATION_WINDOW, Math.ceil(d.bytes.length / ANIMATION_CHUNK_BYTES));
    d.retries = 0;
    if (d.cursor * ANIMATION_CHUNK_BYTES < d.bytes.length) this.requestWindow(c.peer, c.h, entry);
    else void this.finish(entry, d);
  }

  get stats(): { receiving: number; sending: number; pendingBytes: number } {
    const pending = [...this.peers.values()].flatMap((p) => [...p.values()]).filter((e) => e.download);
    return {
      receiving: pending.length, sending: this.sends.size,
      pendingBytes: pending.reduce((n, e) => n + (e.download?.bytes?.length ?? 0), 0),
    };
  }

  private allowed(peer: string): boolean {
    return this.deps.enabled() && this.peers.has(peer) && this.deps.canPeer(peer);
  }

  private source(hash: string): Promise<Source | null> | null {
    const existing = this.sources.get(hash);
    if (existing) return existing.promise;
    if (this.sources.size >= ANIMATION_TRANSFERS_MAX) {
      const free = [...this.sources].find(([h, s]) => s.loaded && ![...this.sends.values()].some((q) => q.h === h));
      if (!free) return null;
      this.sources.delete(free[0]);
    }
    const slot = { loaded: false, promise: Promise.resolve<Source | null>(null) };
    slot.promise = this.deps.animation(hash).then((bytes): Source | null => {
      if (!bytes || bytes.length > ANIM_MAX_BYTES || checkAnim(bytes) !== null) return null;
      const format = sniffImage(bytes);
      if (format !== 'gif' && format !== 'webp') return null;
      return { bytes, info: { a: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, format } };
    }).catch(() => null).finally(() => { slot.loaded = true; });
    this.sources.set(hash, slot);
    return slot.promise;
  }

  private requestWindow(peer: string, hash: string, entry: Entry): void {
    const d = entry.download;
    if (!d || !entry.info || !d.bytes) return;
    if (d.need.size === 0) {
      const end = Math.min(d.cursor + ANIMATION_WINDOW, Math.ceil(d.bytes.length / ANIMATION_CHUNK_BYTES));
      for (let i = d.cursor; i < end; i++) d.need.add(i);
    }
    d.lastAt = this.deps.now();
    this.deps.send(peer, { t: 'anim-want', to: peer, h: hash, a: entry.info.a, need: [...d.need] });
  }

  private async finish(entry: Entry, d: Download): Promise<void> {
    const info = entry.info;
    if (!d.bytes || !info) return;
    d.saving = true;
    try {
      if (createHash('sha256').update(d.bytes).digest('hex') !== info.a ||
          checkAnim(d.bytes) !== null || sniffImage(d.bytes) !== info.format) return;
      await this.deps.put(info.a, d.bytes);
    } catch {
      // A full or unavailable disk leaves the still visible.
    } finally {
      if (entry.download === d) delete entry.download;
      entry.refreshAt = this.deps.now() + METADATA_REFRESH_MS;
    }
  }

  private reset(): void {
    this.invalidateSources();
    for (const entries of this.peers.values()) {
      for (const e of entries.values()) {
        delete e.download;
        e.info = undefined;
        e.refreshAt = 0;
      }
    }
  }

  private tick(): void {
    try {
      if (!this.deps.enabled()) {
        this.reset();
        return;
      }
      const now = this.deps.now();
      let receiving = this.stats.receiving;
      for (const [peer, entries] of this.peers) {
        if (!this.allowed(peer)) {
          for (const e of entries.values()) {
            if (e.download) receiving--;
            delete e.download;
            e.info = undefined;
            e.refreshAt = 0;
          }
          continue;
        }
        for (const [h, e] of entries) {
          const d = e.download;
          if (d) {
            if (d.saving) continue;
            if (now - d.firstAt >= ANIMATION_TIMEOUT_MS || d.retries >= RETRIES && now - d.lastAt >= ANIMATION_RETRY_MS) {
              delete e.download;
              e.refreshAt = now + METADATA_REFRESH_MS;
              receiving--;
            } else if (now - d.lastAt >= ANIMATION_RETRY_MS) {
              d.retries++;
              d.lastAt = now;
              if (d.bytes) this.requestWindow(peer, h, e);
              else this.deps.send(peer, { t: 'anim-want', to: peer, h });
            }
          } else if (receiving < ANIMATION_TRANSFERS_MAX && now >= e.refreshAt) {
            e.download = { firstAt: now, lastAt: now, retries: 0, bytes: null, cursor: 0, need: new Set(), saving: false };
            receiving++;
            this.deps.send(peer, { t: 'anim-want', to: peer, h });
          }
        }
      }
      let sent = 0;
      const perPeer = new Map<string, number>();
      for (const [key, q] of this.sends) {
        if (!this.allowed(q.peer) || !this.deps.announced().includes(q.h) || now - q.at > ANIMATION_RETRY_MS * 2) {
          this.sends.delete(key);
          continue;
        }
        while (q.need.size > 0 && sent < ANIMATION_CHUNKS_PER_TICK && (perPeer.get(q.peer) ?? 0) < ANIMATION_CHUNKS_PER_PEER) {
          const i = q.need.values().next().value;
          if (i === undefined) break;
          q.need.delete(i);
          const bytes = q.source.bytes.subarray(i * ANIMATION_CHUNK_BYTES, (i + 1) * ANIMATION_CHUNK_BYTES);
          this.deps.send(q.peer, {
            t: 'anim-chunk', to: q.peer, h: q.h, a: q.source.info.a, i, b: Buffer.from(bytes).toString('base64'),
          });
          sent++;
          perPeer.set(q.peer, (perPeer.get(q.peer) ?? 0) + 1);
        }
        if (q.need.size === 0) this.sends.delete(key);
      }
    } catch {
      // A vanished route or a failed send must never take down the input helper or the app.
    }
  }
}
