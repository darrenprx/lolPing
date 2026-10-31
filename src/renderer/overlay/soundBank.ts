/** Safety ceiling: more overlapping sounds than this are skipped (the ping still shows). */
export const MAX_VOICES = 8;

/**
 * Manages audio playback with lazy buffer decoding and automatic AudioContext suspension after inactivity
 * to minimize idle RAM and daemon process footprint.
 */
export class SoundBank {
  private ctx: AudioContext | null = null;
  private readonly raw = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private voices = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      void this.ctx.suspend();
    }
    return this.ctx;
  }

  resume(): void {
    const ctx = this.getContext();
    if (ctx.state !== 'running') void ctx.resume();
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.ctx && this.ctx.state === 'running' && this.voices === 0) {
        void this.ctx.suspend();
      }
    }, 15000);
  }

  /** Stores raw compressed audio data; resolves with URLs that failed to load. */
  async load(entries: readonly { key: string; url: string }[]): Promise<string[]> {
    const results = await Promise.all(
      entries.map(async ({ key, url }) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          const ab = await res.arrayBuffer();
          this.raw.set(key, ab);
          return null;
        } catch {
          return url;
        }
      }),
    );
    return results.filter((r): r is string => r !== null);
  }

  /** Decodes raw audio data on demand for active sound keys. */
  async ensureDecoded(key: string): Promise<AudioBuffer | null> {
    const existing = this.buffers.get(key);
    if (existing) return existing;
    const rawData = this.raw.get(key);
    if (!rawData) return null;
    const ctx = this.getContext();
    try {
      const decoded = await ctx.decodeAudioData(rawData.slice(0));
      this.buffers.set(key, decoded);
      return decoded;
    } catch {
      return null;
    }
  }

  /** Plays the sound at `url`, loading and decoding it lazily on first play. */
  async playUrl(url: string, volume01: number): Promise<void> {
    if (!this.raw.has(url)) await this.load([{ key: url, url }]);
    await this.ensureDecoded(url);
    this.play(url, volume01);
  }

  /** Drops loaded sounds matching prefix so they will reload on next play. */
  forget(prefix: string): void {
    for (const key of this.buffers.keys()) if (key.startsWith(prefix)) this.buffers.delete(key);
    for (const key of this.raw.keys()) if (key.startsWith(prefix)) this.raw.delete(key);
  }

  /** Evicts decoded PCM AudioBuffers that are not in the active set to reclaim memory. */
  evictUnused(activeKeys: ReadonlySet<string>): void {
    for (const key of this.buffers.keys()) {
      if (!activeKeys.has(key)) this.buffers.delete(key);
    }
  }

  play(key: string, volume01: number): void {
    if (volume01 <= 0 || this.voices >= MAX_VOICES) return;
    const buffer = this.buffers.get(key);
    if (!buffer) {
      void this.ensureDecoded(key).then((b) => {
        if (b) this.play(key, volume01);
      });
      return;
    }
    const ctx = this.getContext();
    if (ctx.state !== 'running') void ctx.resume();
    this.resetIdleTimer();
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = volume01;
    src.connect(gain).connect(ctx.destination);
    this.voices++;
    src.onended = () => {
      this.voices--;
      this.resetIdleTimer();
    };
    src.start();
  }
}
