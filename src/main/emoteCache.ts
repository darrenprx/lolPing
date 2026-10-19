import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANIM_MAX_BYTES, HASH_RE } from '../shared/emotes';
import { sniffImage } from '../shared/imageSniff';
import { ANIMATION_HASH_RE } from '../shared/roomProtocol';
import { renameWithRetry } from './settingsStore';

/** At most this many stills and this many bytes of friends' emotes are kept; the rest is evicted least recently used first. */
export const CACHE_MAX_FILES = 200;
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;
/** A crashed put leaves a `.tmp` behind; a live one owns its file for milliseconds, so only tmp this old is swept. */
const STALE_TMP_MS = 5 * 60_000;
const NAME_RE = /^([0-9a-f]{32})\.webp$/;
export const ANIMATION_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const ANIMATION_CACHE_MAX_FILES = 32;
const ANIMATION_NAME_RE = /^([0-9a-f]{64})\.anim\.(gif|webp)$/;

/** A capped cache of verified room stills or animation originals, evicted by last use. */
export class EmoteCache {
  readonly dir: string;
  /**
   * What is on disk: each image's size and when it was last stored or shown (the file's mtime after a launch).
   * Kept in use order too, so a tie on `at` goes to the newer use.
   */
  private entries = new Map<string, { size: number; at: number; name: string }>();
  /** Set after the first write failure, so the log says so once and the renderer keeps its fallback. */
  private broken = false;
  private readonly writes = new Map<string, Promise<boolean>>();

  constructor(dir: string, private readonly now: () => number, private readonly animations = false) {
    this.dir = dir;
  }

  /** Reads what earlier sessions left behind. Run once at launch, before anything asks has(). */
  async present(): Promise<void> {
    await this.sweep();
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  /** A display showed this emote: it counts as the most recently used. */
  touch(hash: string): void {
    const e = this.entries.get(hash);
    if (e) this.use(hash, e.size, e.name);
  }

  /** Stores an image already verified against its hash and image header. False when the disk refused. */
  put(hash: string, bytes: Uint8Array): Promise<boolean> {
    const existing = this.writes.get(hash);
    if (existing) return existing; // two peers may offer the same content-addressed animation at once
    const pending = this.write(hash, bytes).finally(() => { this.writes.delete(hash); });
    this.writes.set(hash, pending);
    return pending;
  }

  private async write(hash: string, bytes: Uint8Array): Promise<boolean> {
    if (!(this.animations ? ANIMATION_HASH_RE : HASH_RE).test(hash)) return false;
    const format = this.animations ? sniffImage(bytes) : 'webp';
    if (format !== 'gif' && format !== 'webp') return false;
    if (this.animations && bytes.length > ANIM_MAX_BYTES) return false;
    const name = this.animations ? `${hash}.anim.${format}` : `${hash}.webp`;
    const tmp = join(this.dir, `${name}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, bytes);
      await renameWithRetry(tmp, join(this.dir, name));
      this.use(hash, bytes.length, name);
      await this.evict();
      return this.has(hash);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (!this.broken) {
        this.broken = true;
        console.warn('[emotes] emote cache unavailable:', (err as Error).message);
      }
      return false;
    }
  }

  /** Rebuilds the index from the folder, applies the caps and removes old temp files. A put only evicts. */
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return; // nothing cached yet, or the folder can't be read: empty until a put succeeds
    }
    const entries = new Map<string, { size: number; at: number; name: string }>();
    for (const name of names) {
      const m = (this.animations ? ANIMATION_NAME_RE : NAME_RE).exec(name);
      const tmp = name.endsWith('.tmp');
      if (!m && !tmp) continue;
      try {
        const s = await stat(join(this.dir, name));
        if (m && s.isFile()) entries.set(m[1], { size: s.size, at: this.entries.get(m[1])?.at ?? s.mtimeMs, name });
        else if (this.now() - s.mtimeMs > STALE_TMP_MS) await rm(join(this.dir, name), { force: true }).catch(() => undefined);
      } catch {
        // gone between readdir and stat: it is no longer served either
      }
    }
    this.entries = entries;
    await this.evict();
  }

  private use(hash: string, size: number, name: string): void {
    this.entries.delete(hash);
    this.entries.set(hash, { size, at: this.now(), name });
  }

  /** Applies this cache's file and byte caps, evicting the least recently used. */
  private async evict(): Promise<void> {
    const byUse = [...this.entries].reverse().sort((a, b) => b[1].at - a[1].at);
    let files = 0;
    let bytes = 0;
    for (const [hash, e] of byUse) {
      const maxFiles = this.animations ? ANIMATION_CACHE_MAX_FILES : CACHE_MAX_FILES;
      const maxBytes = this.animations ? ANIMATION_CACHE_MAX_BYTES : CACHE_MAX_BYTES;
      if (files < maxFiles && bytes + e.size <= maxBytes) {
        files++;
        bytes += e.size;
        continue;
      }
      this.entries.delete(hash); // has() says no at once, before the file is gone
      await rm(join(this.dir, e.name), { force: true }).catch(() => undefined);
    }
  }
}
