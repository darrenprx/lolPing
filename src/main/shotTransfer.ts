import { createHash } from 'node:crypto';
import {
  SHOT_CHUNK_BYTES, SHOT_MAX_ASSEMBLIES, SHOT_MAX_BYTES, type ShotBody, type ShotMeta, type ShotParts, type ShotWant,
} from '../shared/roomShots';

export const SHOT_BROADCAST = '0000000000000000';
const TTL_MS = 45_000;
const RETRY_MS = 3000;
const keyOf = (p: { id: string; d: number }): string => `${p.id}:${p.d}`;
export const shotHash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export interface ShotTransferDeps {
  now(): number;
  self(): string;
  peers(): { peer: string; lane: 'lan' | 'shared' }[];
  send(peer: string, body: ShotBody): boolean;
  metadata(peer: string, meta: ShotMeta): void;
  completed(peer: string, meta: ShotMeta, data: Uint8Array): void;
  failed(peer: string, meta: ShotMeta): void;
}
interface Outgoing {
  meta: ShotMeta; data: Uint8Array; at: number;
  queues: Map<string, Set<number>>;
  announced: Map<string, number>;
}
interface Incoming {
  peer: string; meta: ShotMeta; parts: Map<number, Uint8Array>; bytes: number;
  at: number; progress: number; asked: number; retries: number;
}

/** Bounded attachment queues, separate from emotes. LAN uses small packets; relays bundle 16 parts per event. */
export class ShotTransfer {
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly seen = new Map<string, number>();
  constructor(private readonly deps: ShotTransferDeps) {}

  publish(meta: ShotMeta, data: Uint8Array): void {
    if (data.length > SHOT_MAX_BYTES || data.length !== meta.bytes || (meta.status === 'ready' && shotHash(data) !== meta.hash)) return;
    const key = keyOf(meta);
    this.outgoing.delete(key);
    this.outgoing.set(key, { meta, data: data.slice(), at: this.deps.now(), queues: new Map(), announced: new Map() });
    while (this.outgoing.size > 8) {
      const first = this.outgoing.keys().next().value;
      if (first) this.outgoing.delete(first);
    }
  }

  receive(peer: string, body: ShotBody): void {
    if (body.t === 'shot') this.meta(peer, body);
    else if (body.t === 'shotParts') this.parts(peer, body);
    else this.want(peer, body);
  }

  tick(): void {
    const now = this.deps.now();
    for (const [key, out] of this.outgoing) {
      if (now - out.at > TTL_MS) { this.outgoing.delete(key); continue; }
      const peers = this.deps.peers();
      const live = new Set(peers.map((p) => p.lane === 'shared' ? 'shared' : p.peer));
      for (const lane of out.queues.keys()) if (!live.has(lane)) {
        out.queues.delete(lane); out.announced.delete(lane);
      }
      const visited = new Set<string>();
      for (const p of peers) {
        const lane = p.lane === 'shared' ? 'shared' : p.peer;
        if (visited.has(lane)) continue;
        visited.add(lane);
        if (!out.queues.has(lane)) out.queues.set(lane, new Set(Array.from(
          { length: Math.ceil(out.data.length / SHOT_CHUNK_BYTES) }, (_, i) => i)));
        if (now - (out.announced.get(lane) ?? -Infinity) >= RETRY_MS) {
          if (!this.deps.send(p.peer, out.meta)) continue;
          out.announced.set(lane, now);
        }
        const pending = out.queues.get(lane);
        if (!pending?.size || out.meta.status !== 'ready') continue;
        // A shared route is served once: all receivers see it, and filter against their signed metadata.
        const max = p.lane === 'shared' ? 16 : 1;
        const indexes = [...pending].slice(0, max);
        const parts = indexes.map((i) => ({ i, b: Buffer.from(out.data.subarray(
          i * SHOT_CHUNK_BYTES, (i + 1) * SHOT_CHUNK_BYTES)).toString('base64') }));
        if (this.deps.send(p.peer, { t: 'shotParts', id: out.meta.id, rev: out.meta.rev, d: out.meta.d,
          to: p.lane === 'shared' ? SHOT_BROADCAST : p.peer, parts })) for (const i of indexes) pending.delete(i);
      }
    }
    for (const [key, incoming] of this.incoming) {
      if (now - incoming.at > TTL_MS || (incoming.retries >= 3 && now - incoming.asked >= RETRY_MS)) {
        this.incoming.delete(key);
        this.deps.failed(incoming.peer, incoming.meta);
      } else if (now - Math.max(incoming.progress, incoming.asked) >= RETRY_MS) {
        const need = Array.from({ length: Math.ceil(incoming.meta.bytes / SHOT_CHUNK_BYTES) }, (_, i) => i)
          .filter((i) => !incoming.parts.has(i)).slice(0, 64);
        if (this.deps.send(incoming.peer, { t: 'shotWant', id: incoming.meta.id, rev: incoming.meta.rev,
          d: incoming.meta.d, to: incoming.peer, need })) {
          incoming.retries++;
          incoming.asked = now;
        }
      }
    }
  }

  forget(peer: string): void {
    for (const [key, incoming] of this.incoming) if (incoming.peer === peer) this.incoming.delete(key);
    for (const out of this.outgoing.values()) { out.queues.delete(peer); out.announced.delete(peer); }
    for (const key of this.seen.keys()) if (key.startsWith(`${peer}:`)) this.seen.delete(key);
  }

  clear(): void { this.outgoing.clear(); this.incoming.clear(); this.seen.clear(); }
  cancelSending(): void { this.outgoing.clear(); }
  cancelReceiving(): void { this.incoming.clear(); this.seen.clear(); }
  get stats(): { sending: number; receiving: number; bytes: number } {
    return { sending: this.outgoing.size, receiving: this.incoming.size,
      bytes: [...this.incoming.values()].reduce((n, i) => n + i.bytes, 0) };
  }

  private meta(peer: string, meta: ShotMeta): void {
    const key = `${peer}:${keyOf(meta)}`;
    if (meta.rev <= (this.seen.get(key) ?? 0)) return;
    this.seen.delete(key);
    this.seen.set(key, meta.rev);
    while (this.seen.size > 128) { const first = this.seen.keys().next().value; if (first) this.seen.delete(first); }
    this.incoming.delete(key);
    this.deps.metadata(peer, meta);
    if (meta.status !== 'ready') return;
    if (this.incoming.size >= SHOT_MAX_ASSEMBLIES) { this.deps.failed(peer, meta); return; }
    const now = this.deps.now();
    this.incoming.set(key, { peer, meta, parts: new Map(), bytes: 0, at: now, progress: now, asked: now, retries: 0 });
  }

  private parts(peer: string, msg: ShotParts): void {
    if (msg.to !== SHOT_BROADCAST && msg.to !== this.deps.self()) return;
    const key = `${peer}:${keyOf(msg)}`;
    const incoming = this.incoming.get(key);
    if (!incoming || incoming.meta.rev !== msg.rev) return;
    const n = Math.ceil(incoming.meta.bytes / SHOT_CHUNK_BYTES);
    for (const part of msg.parts) {
      if (part.i >= n || incoming.parts.has(part.i)) continue;
      const bytes = Buffer.from(part.b, 'base64');
      const expected = Math.min(SHOT_CHUNK_BYTES, incoming.meta.bytes - part.i * SHOT_CHUNK_BYTES);
      if (bytes.length !== expected) continue;
      incoming.parts.set(part.i, bytes);
      incoming.bytes += bytes.length;
      incoming.progress = this.deps.now();
      incoming.retries = 0;
    }
    if (incoming.parts.size !== n) return;
    this.incoming.delete(key);
    const data = new Uint8Array(incoming.meta.bytes);
    for (const [i, part] of incoming.parts) data.set(part, i * SHOT_CHUNK_BYTES);
    if (shotHash(data) !== incoming.meta.hash) return this.deps.failed(peer, incoming.meta);
    this.deps.completed(peer, incoming.meta, data);
  }

  private want(peer: string, msg: ShotWant): void {
    if (msg.to !== this.deps.self()) return;
    const out = this.outgoing.get(keyOf(msg));
    const route = this.deps.peers().find((p) => p.peer === peer);
    if (!out || !route || out.meta.rev !== msg.rev) return;
    const lane = route.lane === 'shared' ? 'shared' : peer;
    const pending = out.queues.get(lane) ?? new Set<number>();
    const n = Math.ceil(out.data.length / SHOT_CHUNK_BYTES);
    for (const i of msg.need) if (i < n) pending.add(i);
    out.queues.set(lane, pending);
  }
}
