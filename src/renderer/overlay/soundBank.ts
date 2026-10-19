/** Safety ceiling: more overlapping sounds than this are skipped (the ping still shows). */
export const MAX_VOICES = 8;

/** Pre-decoded Web Audio buffers: HTMLAudioElement per play added audible latency in the prototype. */
export class SoundBank {
  private readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, { url: string; result: Promise<string | null> }>();
  private voices = 0;

  /** Decodes every sound up front, each under its key. Resolves with the URLs that failed or were invalidated. */
  async load(entries: readonly { key: string; url: string }[]): Promise<string[]> {
    const results = await Promise.all(
      entries.map(({ key, url }) => {
        const pending = this.loading.get(key);
        if (pending?.url === url) return pending.result;
        const result: Promise<string | null> = this.fetchBuffer(url).then(
          (buffer) => {
            // A settings change can forget or replace this sound before its decode finishes.
            if (this.loading.get(key)?.result !== result) return url;
            this.buffers.set(key, buffer);
            return null;
          },
          () => url,
        ).finally(() => {
          if (this.loading.get(key)?.result === result) this.loading.delete(key);
        });
        this.loading.set(key, { url, result });
        return result;
      }),
    );
    return results.filter((r): r is string => r !== null);
  }

  /** Plays the sound at `url`, loading it under that key the first time. A file that won't load plays nothing. */
  async playUrl(url: string, volume01: number): Promise<void> {
    if (!this.buffers.has(url)) {
      const failed = await this.load([{ key: url, url }]);
      if (failed.length > 0) return;
    }
    this.play(url, volume01);
  }

  /** Drops cached and pending sounds whose key starts with `prefix`, so the next play loads them again. */
  forget(prefix: string): void {
    for (const key of this.buffers.keys()) if (key.startsWith(prefix)) this.buffers.delete(key);
    for (const key of this.loading.keys()) if (key.startsWith(prefix)) this.loading.delete(key);
  }

  play(key: string, volume01: number): void {
    const buffer = this.buffers.get(key);
    if (!buffer || volume01 <= 0 || this.voices >= MAX_VOICES) return;
    if (this.ctx.state !== 'running') void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = volume01;
    src.connect(gain).connect(this.ctx.destination);
    this.voices++;
    src.onended = () => this.voices--;
    src.start();
  }

  private async fetchBuffer(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }
}
