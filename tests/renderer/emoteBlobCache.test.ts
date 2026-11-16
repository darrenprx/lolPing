import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmoteBlobCache, EMOTE_BLOB_CACHE_MAX_BYTES } from '../../src/renderer/overlay/emoteBlobCache';
import { EMOTE_CATALOG } from '../../src/shared/emoteCatalog';

function deferred<T>() {
  let finish: (value: T) => void = () => { throw new Error('Uninitialized promise'); };
  const promise = new Promise<T>((resolve) => { finish = resolve; });
  return { promise, resolve: (value: T) => finish(value) };
}

function fixture(sizes: Record<string, number>, budget: number) {
  const reads: string[] = [];
  const cache = new EmoteBlobCache(async (url) => {
    reads.push(url);
    return new Blob([new Uint8Array(sizes[url])]);
  }, budget);
  return { cache, reads };
}

describe('EmoteBlobCache', () => {
  it('returns the same Blob on a cache hit', async () => {
    const { cache, reads } = fixture({ a: 4 }, 10);
    const first = await cache.get('a');
    expect(await cache.get('a')).toBe(first);
    expect(first.size).toBe(4);
    expect(reads).toEqual(['a']);
  });

  it('evicts the least recently used Blob rather than the oldest insertion', async () => {
    const { cache, reads } = fixture({ a: 4, b: 4, c: 4 }, 8);
    const a = await cache.get('a');
    const b = await cache.get('b');
    expect(await cache.get('a')).toBe(a);
    await cache.get('c');
    expect(await cache.get('a')).toBe(a);
    expect(await cache.get('b')).not.toBe(b);
    expect(reads).toEqual(['a', 'b', 'c', 'b']);
  });

  it('evicts as many old entries as a larger Blob needs', async () => {
    const { cache, reads } = fixture({ a: 2, b: 3, c: 4, d: 7 }, 10);
    const a = await cache.get('a');
    const b = await cache.get('b');
    const c = await cache.get('c');
    const d = await cache.get('d');
    expect(await cache.get('d')).toBe(d);
    expect(await cache.get('a')).not.toBe(a);
    expect(await cache.get('b')).not.toBe(b);
    expect(await cache.get('c')).not.toBe(c);
    expect(reads).toEqual(['a', 'b', 'c', 'd', 'a', 'b', 'c']);
  });

  it('keeps entries whose total is exactly the budget', async () => {
    const { cache, reads } = fixture({ a: 6, b: 4 }, 10);
    const a = await cache.get('a');
    const b = await cache.get('b');
    expect(await cache.get('a')).toBe(a);
    expect(await cache.get('b')).toBe(b);
    expect(reads).toEqual(['a', 'b']);
  });

  it('serves an oversized Blob without caching it or discarding other entries', async () => {
    const { cache, reads } = fixture({ a: 6, b: 4, large: 11 }, 10);
    const a = await cache.get('a');
    const b = await cache.get('b');
    const large = await cache.get('large');
    expect(large.size).toBe(11);
    expect(await cache.get('large')).not.toBe(large);
    expect(await cache.get('a')).toBe(a);
    expect(await cache.get('b')).toBe(b);
    expect(reads).toEqual(['a', 'b', 'large', 'large']);
  });

  it('shares a pending fetch between callers and gives them the same Blob', async () => {
    const response = deferred<Blob>();
    const reads: string[] = [];
    const cache = new EmoteBlobCache((url) => {
      reads.push(url);
      return response.promise;
    }, 10);
    const first = cache.get('a');
    const second = cache.get('a');
    response.resolve(new Blob(['animation']));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(await a.text()).toBe('animation');
    expect(await cache.get('a')).toBe(a);
    expect(reads).toEqual(['a']);
  });

  it('applies the byte budget when pending fetches finish out of order', async () => {
    const first = deferred<Blob>();
    const second = deferred<Blob>();
    const reads: string[] = [];
    const cache = new EmoteBlobCache((url) => {
      const previous = reads.includes(url);
      reads.push(url);
      return previous ? Promise.resolve(new Blob(['new'])) : url === 'a' ? first.promise : second.promise;
    }, 10);
    const a = cache.get('a');
    const b = cache.get('b');
    second.resolve(new Blob(['bbbbbbb']));
    const oldB = await b;
    first.resolve(new Blob(['aaaaaaa']));
    const oldA = await a;
    expect(await cache.get('a')).toBe(oldA);
    expect(await cache.get('b')).not.toBe(oldB);
    expect(reads).toEqual(['a', 'b', 'b']);
  });

  it('retries a failed fetch rather than retaining its rejected Promise', async () => {
    let broken = true;
    const cache = new EmoteBlobCache(async () => {
      if (broken) throw new Error('Missing animation');
      return new Blob(['animation']);
    }, 10);
    await expect(cache.get('a')).rejects.toThrow('Missing animation');
    broken = false;
    expect(await (await cache.get('a')).text()).toBe('animation');
  });

  it('turns a synchronous fetch failure into a rejection and permits a retry', async () => {
    let broken = true;
    const cache = new EmoteBlobCache(() => {
      if (broken) throw new Error('Fetch failed');
      return Promise.resolve(new Blob(['animation']));
    }, 10);
    await expect(cache.get('a')).rejects.toThrow('Fetch failed');
    broken = false;
    expect(await (await cache.get('a')).text()).toBe('animation');
  });

  it('can hold even the nine largest animations in the current catalogue', () => {
    const largest = EMOTE_CATALOG.map((e) => statSync(join(__dirname, '../../assets/emotes', `${e.slug}.webp`)).size)
      .sort((a, b) => b - a).slice(0, 9);
    expect(largest.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(EMOTE_BLOB_CACHE_MAX_BYTES);
  });
});
