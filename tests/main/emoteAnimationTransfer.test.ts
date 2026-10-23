import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANIMATION_CHUNKS_PER_TICK, ANIMATION_RETRY_MS, ANIMATION_TRANSFERS_MAX, EmoteAnimationTransfer,
  type EmoteAnimationTransferDeps,
} from '../../src/main/emoteAnimationTransfer';
import { ANIM_MAX_BYTES, customAnimUrl } from '../../src/shared/emotes';
import {
  ANIMATION_CHUNK_BYTES, ANIMATION_WINDOW, type AnimationChunkMsg, type AnimationInfo,
  type AnimationWantMsg,
} from '../../src/shared/roomProtocol';

const PEER = 'a'.repeat(16);
const SELF = 'b'.repeat(16);
const HASH = 'c'.repeat(32);
const base = { peer: PEER, seq: 1, ts: 0, to: SELF, h: HASH };
const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Header-sized fixtures exercise transfer bounds without asking an image decoder to run in Node. */
const gif = (size = 2000, seed = 1): Uint8Array => {
  const bytes = new Uint8Array(size).fill(seed);
  bytes.set([...Buffer.from('GIF89a'), 100, 0, 80, 0, 0, 0, 0, 0x3b]);
  return bytes;
};
const infoOf = (bytes: Uint8Array): AnimationInfo => ({ a: hashOf(bytes), size: bytes.length, format: 'gif' });

function harness() {
  const state = { enabled: true, allowed: true, announced: [HASH] };
  const out: { peer: string; body: Record<string, unknown> }[] = [];
  const files = new Map<string, Uint8Array>();
  const cache = new Map<string, Uint8Array>();
  const deps: EmoteAnimationTransferDeps = {
    now: Date.now,
    enabled: () => state.enabled,
    canPeer: () => state.allowed,
    announced: () => state.announced,
    animation: async (h) => files.get(h) ?? null,
    have: (h) => cache.has(h),
    put: async (h, b) => { cache.set(h, b); return true; },
    touch: () => undefined,
    send: (peer, body) => { out.push({ peer, body }); },
  };
  const transfer = new EmoteAnimationTransfer(deps);
  transfer.announced(PEER, [HASH]);
  return { transfer, state, out, files, cache, deps };
}

async function begin(h: ReturnType<typeof harness>, bytes: Uint8Array): Promise<AnimationInfo> {
  await vi.advanceTimersByTimeAsync(100);
  const info = infoOf(bytes);
  h.transfer.onInfo({ ...base, t: 'anim-info', info });
  return info;
}

function chunk(bytes: Uint8Array, i: number, info = infoOf(bytes)): AnimationChunkMsg {
  return {
    ...base, t: 'anim-chunk', a: info.a, i,
    b: Buffer.from(bytes.subarray(i * ANIMATION_CHUNK_BYTES, (i + 1) * ANIMATION_CHUNK_BYTES)).toString('base64'),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('EmoteAnimationTransfer', () => {
  it.each([600_000, ANIM_MAX_BYTES])('receives a %i-byte original in bounded windows and verifies every byte', async (size) => {
    const h = harness();
    const bytes = gif(size);
    const info = await begin(h, bytes);
    expect(h.transfer.url(PEER, HASH)).toBeNull();
    for (let i = 0; i < Math.ceil(size / ANIMATION_CHUNK_BYTES); i++) h.transfer.onChunk(chunk(bytes, i, info));
    await Promise.resolve();
    expect(Buffer.from(h.cache.get(info.a) ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(h.transfer.url(PEER, HASH)).toBe(customAnimUrl(info.a));
    expect(h.transfer.stats.receiving).toBe(0);
    const wants = h.out.filter((o) => o.body.a);
    expect(wants.length).toBeGreaterThan(1);
    expect(wants.every((o) => Array.isArray(o.body.need) && o.body.need.length <= ANIMATION_WINDOW)).toBe(true);
  });

  it('requests only missing indexes after loss, tolerates reordering and ignores duplicates', async () => {
    const h = harness();
    const bytes = gif(ANIMATION_CHUNK_BYTES * 3);
    const info = await begin(h, bytes);
    h.transfer.onChunk(chunk(bytes, 2, info));
    h.transfer.onChunk(chunk(bytes, 2, info));
    h.transfer.onChunk(chunk(bytes, 0, info));
    await vi.advanceTimersByTimeAsync(ANIMATION_RETRY_MS);
    expect(h.out.at(-1)?.body.need).toEqual([1]);
    h.transfer.onChunk(chunk(bytes, 1, info));
    await Promise.resolve();
    expect(h.cache.get(info.a)).toEqual(bytes);
  });

  it('receives and serves an animated WebP original with its own format binding', async () => {
    const h = harness();
    const bytes = new Uint8Array(2000);
    bytes.set(Buffer.from('RIFF'));
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
    bytes.set(Buffer.from('WEBPVP8X'), 8);
    bytes.set([10, 0, 0, 0, 0x12, 0, 0, 0, 99, 0, 0, 79, 0, 0], 16);
    const info: AnimationInfo = { a: hashOf(bytes), size: bytes.length, format: 'webp' };
    await vi.advanceTimersByTimeAsync(100);
    h.transfer.onInfo({ ...base, t: 'anim-info', info });
    for (let i = 0; i < 4; i++) h.transfer.onChunk(chunk(bytes, i, info));
    await Promise.resolve();
    expect(h.cache.get(info.a)).toEqual(bytes);
    h.files.set(HASH, bytes);
    await h.transfer.onWant({ ...base, t: 'anim-want' });
    expect(h.out.at(-1)?.body.info).toEqual(info);
  });

  it.each(['wrong hash', 'wrong type', 'oversized dimensions', 'wrong format'])('discards an original with %s', async (failure) => {
    const h = harness();
    const bytes = gif();
    if (failure === 'wrong type') bytes[0] = 0;
    if (failure === 'oversized dimensions') { bytes[6] = 255; bytes[7] = 255; }
    const info = await begin(h, bytes);
    if (failure === 'wrong hash') bytes[bytes.length - 1] ^= 1;
    if (failure === 'wrong format') info.format = 'webp';
    for (let i = 0; i < Math.ceil(bytes.length / ANIMATION_CHUNK_BYTES); i++) h.transfer.onChunk(chunk(bytes, i, info));
    await Promise.resolve();
    expect(h.cache.size).toBe(0);
    expect(h.transfer.url(PEER, HASH)).toBeNull();
  });

  it('ignores unsolicited metadata, another sender, unrequested chunks and wrong chunk lengths', async () => {
    const h = harness();
    const bytes = gif(ANIMATION_CHUNK_BYTES * 40);
    const info = infoOf(bytes);
    h.transfer.onInfo({ ...base, t: 'anim-info', info });
    expect(h.transfer.stats.pendingBytes).toBe(0);
    await begin(h, bytes);
    const valid = chunk(bytes, 0, info);
    h.transfer.onChunk({ ...valid, peer: 'd'.repeat(16) });
    h.transfer.onChunk({ ...valid, a: 'e'.repeat(64) });
    h.transfer.onChunk({ ...valid, b: 'AA==' });
    h.transfer.onChunk(chunk(bytes, 35, info));
    await vi.advanceTimersByTimeAsync(ANIMATION_RETRY_MS);
    expect(h.out.at(-1)?.body.need).toEqual(Array.from({ length: ANIMATION_WINDOW }, (_, i) => i));
  });

  it('binds different animations to their senders even when their thumbnail hash is the same', async () => {
    const h = harness();
    const other = 'd'.repeat(16);
    h.transfer.announced(other, [HASH]);
    const a = gif(2000, 1);
    const b = gif(2000, 2);
    const ia = await begin(h, a);
    const ib = infoOf(b);
    h.transfer.onInfo({ ...base, peer: other, t: 'anim-info', info: ib });
    for (let i = 0; i < 4; i++) {
      h.transfer.onChunk(chunk(a, i, ia));
      h.transfer.onChunk({ ...chunk(b, i, ib), peer: other });
    }
    await Promise.resolve();
    expect(h.transfer.url(PEER, HASH)).toBe(customAnimUrl(ia.a));
    expect(h.transfer.url(other, HASH)).toBe(customAnimUrl(ib.a));
  });

  it('caps total receiving memory even when many announced emotes claim maximum-sized originals', async () => {
    const h = harness();
    const hashes = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(32, '0'));
    h.transfer.announced(PEER, hashes);
    await vi.advanceTimersByTimeAsync(100);
    const info = infoOf(gif(ANIM_MAX_BYTES));
    for (const hash of hashes) h.transfer.onInfo({ ...base, h: hash, t: 'anim-info', info });
    expect(h.transfer.stats.receiving).toBe(ANIMATION_TRANSFERS_MAX);
    expect(h.transfer.stats.pendingBytes).toBe(ANIMATION_TRANSFERS_MAX * ANIM_MAX_BYTES);
  });

  it.each(['disabled', 'muted or lost LAN', 'left', 'unannounced'])('cancels receiving when %s', async (reason) => {
    const h = harness();
    const bytes = gif();
    const info = await begin(h, bytes);
    if (reason === 'disabled') h.state.enabled = false;
    if (reason === 'muted or lost LAN') h.state.allowed = false;
    if (reason === 'left') h.transfer.memberGone(PEER);
    if (reason === 'unannounced') h.transfer.announced(PEER, []);
    await vi.advanceTimersByTimeAsync(100);
    h.transfer.onChunk(chunk(bytes, 0, info));
    expect(h.transfer.stats.pendingBytes).toBe(0);
    expect(h.transfer.url(PEER, HASH)).toBeNull();
  });

  it('bounds retries and releases a stalled assembly', async () => {
    const h = harness();
    await begin(h, gif());
    await vi.advanceTimersByTimeAsync(ANIMATION_RETRY_MS * 4);
    expect(h.transfer.stats.receiving).toBe(0);
    expect(h.transfer.stats.pendingBytes).toBe(0);
  });

  it('keeps a progressing maximum-sized download alive beyond five minutes', async () => {
    const h = harness();
    const bytes = gif(ANIM_MAX_BYTES);
    const info = await begin(h, bytes);
    for (let i = 0; i < 160; i++) {
      h.transfer.onChunk(chunk(bytes, i, info));
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(h.transfer.stats.pendingBytes).toBe(ANIM_MAX_BYTES);
  });

  it.each(['disabled', 'muted or lost LAN', 'left', 'unannounced'])('cancels queued serving when %s', async (reason) => {
    const h = harness();
    const bytes = gif();
    h.files.set(HASH, bytes);
    await h.transfer.onWant({ ...base, t: 'anim-want', a: hashOf(bytes), need: [0, 1, 2] });
    if (reason === 'disabled') h.state.enabled = false;
    if (reason === 'muted or lost LAN') h.state.allowed = false;
    if (reason === 'left') h.transfer.memberGone(PEER);
    if (reason === 'unannounced') h.state.announced = [];
    await vi.advanceTimersByTimeAsync(100);
    expect(h.transfer.stats.sending).toBe(0);
    expect(h.out.some((o) => o.body.t === 'anim-chunk')).toBe(false);
  });

  it('never requests, serves or plays originals over a disallowed route', async () => {
    const h = harness();
    h.state.allowed = false;
    h.files.set(HASH, gif());
    await vi.advanceTimersByTimeAsync(100);
    await h.transfer.onWant({ ...base, t: 'anim-want' });
    expect(h.out).toEqual([]);
    expect(h.transfer.url(PEER, HASH)).toBeNull();
  });

  it('serves signed metadata and paces each requested window within the total egress cap', async () => {
    const h = harness();
    const bytes = gif(ANIMATION_CHUNK_BYTES * 40);
    h.files.set(HASH, bytes);
    const want: AnimationWantMsg = { ...base, t: 'anim-want' };
    await h.transfer.onWant(want);
    expect(h.out[0].body).toEqual({ t: 'anim-info', to: PEER, h: HASH, info: infoOf(bytes) });
    const need = Array.from({ length: ANIMATION_WINDOW }, (_, i) => i);
    for (const peer of [PEER, 'd'.repeat(16), 'e'.repeat(16)]) {
      h.transfer.announced(peer, []);
      await h.transfer.onWant({ ...want, peer, a: hashOf(bytes), need });
    }
    expect(h.transfer.stats.sending).toBe(ANIMATION_TRANSFERS_MAX);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.body.t === 'anim-chunk')).toHaveLength(ANIMATION_CHUNKS_PER_TICK);
    await vi.advanceTimersByTimeAsync(500);
    const chunks = h.out.filter((o) => o.body.t === 'anim-chunk');
    expect(chunks).toHaveLength(ANIMATION_WINDOW * 2);
    expect(chunks.every((o) => String(o.body.b).length <= ANIMATION_CHUNK_BYTES / 3 * 4)).toBe(true);
  });

  it('refuses to serve unannounced or oversized local originals', async () => {
    const h = harness();
    const want: AnimationWantMsg = { ...base, t: 'anim-want' };
    h.files.set(HASH, gif(ANIM_MAX_BYTES + 1));
    await h.transfer.onWant(want);
    expect(h.out.at(-1)?.body.info).toBeNull();
    h.out.length = 0;
    h.state.announced = [];
    await h.transfer.onWant(want);
    expect(h.out).toEqual([]);
  });

  it('drops a library read completed after disable or a source invalidation', async () => {
    const h = harness();
    let resolve: (b: Uint8Array) => void = () => undefined;
    h.deps.animation = () => new Promise((r) => { resolve = r; });
    const pending = h.transfer.onWant({ ...base, t: 'anim-want' });
    h.transfer.invalidateSources();
    resolve(gif());
    await pending;
    expect(h.out).toEqual([]);
  });

  it('keeps a verified cached animation usable when refreshing the signed metadata', async () => {
    const h = harness();
    const bytes = gif();
    const info = infoOf(bytes);
    h.cache.set(info.a, bytes);
    await begin(h, bytes);
    expect(h.transfer.stats.pendingBytes).toBe(0);
    expect(h.transfer.url(PEER, HASH)).toBe(customAnimUrl(info.a));
  });
});
