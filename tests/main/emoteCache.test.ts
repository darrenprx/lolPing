import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANIMATION_CACHE_MAX_BYTES, CACHE_MAX_BYTES, CACHE_MAX_FILES, EmoteCache } from '../../src/main/emoteCache';

const HASH = (n: number): string => n.toString(16).padStart(32, '0');
const stillOf = (n: number, size: number): Uint8Array => new Uint8Array(size).fill(n + 1);
const webpNames = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.webp'));
const NAME = /^([0-9a-f]{32})\.webp$/;

let dir: string;
let cache: EmoteCache;
let clock: number;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'lolping-emote-cache-')), 'emote-cache');
  clock = Date.now() + 5000;
  cache = new EmoteCache(dir, () => clock);
});

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('EmoteCache', () => {
  it('coalesces simultaneous writes of the same verified content into one complete file', async () => {
    const animations = new EmoteCache(dir, () => clock, true);
    const hash = 'a'.repeat(64);
    const bytes = new Uint8Array([...Buffer.from('GIF89a'), 2, 0, 2, 0]);
    expect(await Promise.all([animations.put(hash, bytes), animations.put(hash, bytes)])).toEqual([true, true]);
    expect(animations.has(hash)).toBe(true);
    expect(readdirSync(dir)).toEqual([`${hash}.anim.gif`]);
  });
  it('keeps independently hashed animation files across launches without changing the still cache', async () => {
    const animations = new EmoteCache(dir, () => clock, true);
    const hash = 'a'.repeat(64);
    const bytes = new Uint8Array([...Buffer.from('GIF89a'), 2, 0, 2, 0]);
    expect(await animations.put(hash, bytes)).toBe(true);
    expect(existsSync(join(dir, `${hash}.anim.gif`))).toBe(true);
    const again = new EmoteCache(dir, () => clock, true);
    await again.present();
    expect(again.has(hash)).toBe(true);
    expect(cache.has(hash)).toBe(false);
    expect(await animations.put('../escape', bytes)).toBe(false);
    expect(await animations.put(HASH(1), bytes)).toBe(false);
    expect(await animations.put('b'.repeat(64), Buffer.from('<svg/>'))).toBe(false);
  });

  it('evicts animations at their separate byte cap and protects a recently shown original', async () => {
    const animations = new EmoteCache(dir, () => clock, true);
    const size = 5 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    bytes.set(Buffer.from('GIF89a'));
    const hash = (n: number): string => n.toString(16).padStart(64, '0');
    for (let i = 0; i < ANIMATION_CACHE_MAX_BYTES / size; i++) await animations.put(hash(i), bytes);
    animations.touch(hash(0));
    await animations.put(hash(100), bytes);
    expect(animations.has(hash(0))).toBe(true);
    expect(animations.has(hash(1))).toBe(false);
    expect(animations.has(hash(100))).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith('.gif')).length * size).toBeLessThanOrEqual(ANIMATION_CACHE_MAX_BYTES);
  });

  it('stores a verified still and finds it again after a relaunch', async () => {
    expect(await cache.put(HASH(1), stillOf(1, 100))).toBe(true);
    expect(cache.has(HASH(1))).toBe(true);
    expect(cache.has(HASH(2))).toBe(false);

    const again = new EmoteCache(dir, () => clock);
    await again.present();
    expect(again.has(HASH(1))).toBe(true);
  });

  it('refuses a hash that is not 32 hex characters', async () => {
    expect(await cache.put('../escape', stillOf(1, 100))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  // Filling the cache is CACHE_MAX_FILES writes; on a busy CI runner that alone crossed the 5 s default (1.1 s on an
  // idle one), which read as a flake in every PR's Linux job.
  it('evicts the least recently used still beyond the cap, and touch() protects a shown one', { timeout: 20_000 }, async () => {
    for (let n = 0; n < CACHE_MAX_FILES; n++) {
      expect(await cache.put(HASH(n), stillOf(n, 100))).toBe(true);
      const at = new Date(Date.now() - (CACHE_MAX_FILES - n) * 1000); // HASH(0) is the oldest on disk, HASH(1) the next
      utimesSync(join(dir, `${HASH(n)}.webp`), at, at);
    }
    const relaunched = new EmoteCache(dir, () => clock); // after a launch, last use comes from the files' mtimes
    await relaunched.present();
    relaunched.touch(HASH(0)); // a display showed the oldest file just now
    await relaunched.put(HASH(CACHE_MAX_FILES), stillOf(1, 100)); // one over the cap: exactly one goes
    expect(webpNames(dir)).toHaveLength(CACHE_MAX_FILES);
    expect(relaunched.has(HASH(0))).toBe(true); // shown beats old
    expect(relaunched.has(HASH(1))).toBe(false); // the runner-up went instead
    expect(relaunched.has(HASH(CACHE_MAX_FILES))).toBe(true);
  });

  it('keeps at most CACHE_MAX_FILES files', async () => {
    for (let n = 0; n < CACHE_MAX_FILES + 5; n++) await cache.put(HASH(n), stillOf(n, 100));
    expect(webpNames(dir)).toHaveLength(CACHE_MAX_FILES);
    expect(cache.has(HASH(0))).toBe(false); // the oldest five went
    expect(cache.has(HASH(CACHE_MAX_FILES + 4))).toBe(true);
  });

  it('keeps at most CACHE_MAX_BYTES', async () => {
    const perFile = 300_000; // 4 MB / 300 KB ≈ 14 files
    for (let n = 0; n < 20; n++) await cache.put(HASH(n), stillOf(n, perFile));
    expect(webpNames(dir).length * perFile).toBeLessThanOrEqual(CACHE_MAX_BYTES);
    expect(webpNames(dir).length).toBeLessThan(20);
  });

  it('answers false and logs once when the folder cannot be created', async () => {
    mkdirSync(dir, { recursive: true });
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'a file where the cache folder should be');
    const broken = new EmoteCache(blocker, () => clock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await broken.put(HASH(1), stillOf(1, 100))).toBe(false);
    expect(await broken.put(HASH(2), stillOf(2, 100))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(broken.has(HASH(1))).toBe(false);
  });

  it('sweep ignores unknown names and forgets files that vanished', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'note.txt'), 'not an emote');
    await cache.put(HASH(3), stillOf(3, 100));
    rmSync(join(dir, `${HASH(3)}.webp`));
    await cache.sweep();
    expect(cache.has(HASH(3))).toBe(false);
  });
});

describe('EmoteCache: audit regressions', () => {
  it('forgets an evicted hash at once: no stale has() until the next put', async () => {
    for (let n = 0; n < CACHE_MAX_FILES + 1; n++) await cache.put(HASH(n), stillOf(n, 100));
    expect(webpNames(dir)).toHaveLength(CACHE_MAX_FILES);
    expect(cache.has(HASH(0))).toBe(false); // the eviction is visible to has() at once, without another put
    const onDisk = readdirSync(dir).map((f) => NAME.exec(f)?.[1]).filter((h) => h !== undefined) as string[];
    for (const h of onDisk) expect(cache.has(h)).toBe(true); // and nothing on disk is missing from the index
  });

  it('sweeps temp files a crashed write left, once they are old enough', async () => {
    mkdirSync(dir, { recursive: true });
    const old = join(dir, `${HASH(1)}.webp.tmp`);
    const fresh = join(dir, `${HASH(2)}.webp.tmp`);
    writeFileSync(old, 'left by a crash');
    writeFileSync(fresh, 'owned by a live put');
    const ago = new Date(Date.now() - 10 * 60_000);
    utimesSync(old, ago, ago);
    await cache.sweep();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // a live put owns its tmp for milliseconds: it stays
  });
});
