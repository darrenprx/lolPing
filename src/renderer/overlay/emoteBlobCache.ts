/** Enough for any current nine-emote wheel, without retaining the whole catalogue. */
export const EMOTE_BLOB_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** Shares pending fetches and retains recently used animation Blobs within a byte budget. */
export class EmoteBlobCache {
  private readonly ready = new Map<string, Blob>();
  private readonly pending = new Map<string, Promise<Blob>>();
  private bytes = 0;

  constructor(
    private readonly fetchBlob: (url: string) => Promise<Blob>,
    private readonly maxBytes = EMOTE_BLOB_CACHE_MAX_BYTES,
  ) {}

  get(url: string): Promise<Blob> {
    const cached = this.ready.get(url);
    if (cached) {
      this.ready.delete(url);
      this.ready.set(url, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(url);
    if (pending) return pending;
    const result = Promise.resolve().then(() => this.fetchBlob(url)).then((blob) => {
      this.remember(url, blob);
      return blob;
    }).finally(() => this.pending.delete(url));
    this.pending.set(url, result);
    return result;
  }

  private remember(url: string, blob: Blob): void {
    // Oversized animations can still play through their object URLs without evicting the whole cache.
    if (blob.size > this.maxBytes) return;
    this.ready.set(url, blob);
    this.bytes += blob.size;
    for (const [oldUrl, oldBlob] of this.ready) {
      if (this.bytes <= this.maxBytes) break;
      this.ready.delete(oldUrl);
      this.bytes -= oldBlob.size;
    }
  }
}
