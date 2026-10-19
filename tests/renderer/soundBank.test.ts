import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VOICES, SoundBank } from '../../src/renderer/overlay/soundBank';

interface BufferData {
  bytes: number[];
}

class Source {
  buffer: BufferData | null = null;
  onended: (() => void) | null = null;
  private gain: { gain: { value: number } } | null = null;

  constructor(private readonly started: Array<{ bytes: number[]; volume: number }>) {}

  connect(gain: { gain: { value: number }; connect(): void }): typeof gain {
    this.gain = gain;
    return gain;
  }

  start(): void {
    if (this.buffer && this.gain) this.started.push({ bytes: this.buffer.bytes, volume: this.gain.gain.value });
  }
}

/** Records decoded data and the signal sent to the output, without browser audio hardware. */
class AudioContextFixture {
  state = 'running';
  destination = {};
  readonly decoded: BufferData[] = [];
  readonly started: Array<{ bytes: number[]; volume: number }> = [];
  readonly sources: Source[] = [];

  async decodeAudioData(bytes: ArrayBuffer): Promise<BufferData> {
    const buffer = { bytes: [...new Uint8Array(bytes)] };
    this.decoded.push(buffer);
    return buffer;
  }

  createBufferSource(): Source {
    const source = new Source(this.started);
    this.sources.push(source);
    return source;
  }

  createGain() {
    return { gain: { value: 1 }, connect: () => undefined };
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }
}

const contexts: AudioContextFixture[] = [];
const requests: string[] = [];
let responseStatus = 200;

beforeEach(() => {
  contexts.length = 0;
  requests.length = 0;
  responseStatus = 200;
  vi.stubGlobal('AudioContext', class extends AudioContextFixture {
    constructor() {
      super();
      contexts.push(this);
    }
  });
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return new Response(Uint8Array.from([1, 2, 3]), { status: responseStatus });
  });
});

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolveValue: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>((resolve) => { resolveValue = resolve; });
  return { promise, resolve: (value: T) => resolveValue(value) };
}

describe('SoundBank', () => {
  it('shares one decoded buffer but plays every concurrent request separately', async () => {
    const bank = new SoundBank();
    await Promise.all(Array.from({ length: MAX_VOICES }, (_, i) => bank.playUrl('custom.sound', (i + 1) / 10)));
    expect(requests).toEqual(['custom.sound']);
    expect(contexts[0].decoded).toEqual([{ bytes: [1, 2, 3] }]);
    expect(contexts[0].started.map((s) => s.volume)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    expect(new Set(contexts[0].sources.map((s) => s.buffer)).size).toBe(1);
  });

  it('shares a pending preload with a playback request for the same key and URL', async () => {
    const bank = new SoundBank();
    const preload = bank.load([{ key: 'custom.sound', url: 'custom.sound' }]);
    await bank.playUrl('custom.sound', 0.5);
    expect(await preload).toEqual([]);
    await bank.playUrl('custom.sound', 0.25);
    expect(requests).toEqual(['custom.sound']);
    expect(contexts[0].decoded).toEqual([{ bytes: [1, 2, 3] }]);
    expect(contexts[0].started).toEqual([
      { bytes: [1, 2, 3], volume: 0.5 },
      { bytes: [1, 2, 3], volume: 0.25 },
    ]);
  });

  it('can retry a shared failed load without leaving a pending entry behind', async () => {
    const bank = new SoundBank();
    responseStatus = 404;
    await Promise.all([bank.playUrl('custom.sound', 0.5), bank.playUrl('custom.sound', 0.25)]);
    expect(contexts[0].started).toEqual([]);
    responseStatus = 200;
    await Promise.all([bank.playUrl('custom.sound', 0.5), bank.playUrl('custom.sound', 0.25)]);
    expect(requests).toEqual(['custom.sound', 'custom.sound']);
    expect(contexts[0].decoded).toEqual([{ bytes: [1, 2, 3] }]);
    expect(contexts[0].started.map((s) => s.volume)).toEqual([0.5, 0.25]);
  });

  it('can retry after decoding a shared response fails', async () => {
    const bank = new SoundBank();
    const decode = contexts[0].decodeAudioData.bind(contexts[0]);
    let broken = true;
    contexts[0].decodeAudioData = async (bytes) => {
      if (broken) throw new Error('Invalid audio');
      return decode(bytes);
    };
    await Promise.all([bank.playUrl('custom.sound', 0.5), bank.playUrl('custom.sound', 0.25)]);
    expect(contexts[0].started).toEqual([]);
    broken = false;
    await Promise.all([bank.playUrl('custom.sound', 0.5), bank.playUrl('custom.sound', 0.25)]);
    expect(requests).toEqual(['custom.sound', 'custom.sound']);
    expect(contexts[0].decoded).toEqual([{ bytes: [1, 2, 3] }]);
    expect(contexts[0].started.map((s) => s.volume)).toEqual([0.5, 0.25]);
  });

  it('keeps sharing the replacement load when an invalidated request finishes first', async () => {
    const bank = new SoundBank();
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    const responses = [oldResponse.promise, newResponse.promise];
    vi.stubGlobal('fetch', (url: string) => {
      requests.push(url);
      const next = responses.shift();
      if (!next) throw new Error('Unexpected fetch');
      return next;
    });
    const oldPlay = bank.playUrl('custom.sound', 0.5);
    bank.forget('custom.');
    const first = bank.playUrl('custom.sound', 0.25);
    oldResponse.resolve(new Response(Uint8Array.from([1, 2, 3])));
    await oldPlay;
    const second = bank.playUrl('custom.sound', 0.75);
    newResponse.resolve(new Response(Uint8Array.from([4, 5, 6])));
    await Promise.all([first, second]);
    expect(requests).toEqual(['custom.sound', 'custom.sound']);
    expect(contexts[0].started).toEqual([
      { bytes: [4, 5, 6], volume: 0.25 },
      { bytes: [4, 5, 6], volume: 0.75 },
    ]);
  });

  it('does not restore or play an old fetch after its sound is replaced', async () => {
    const bank = new SoundBank();
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    const responses = [oldResponse.promise, newResponse.promise];
    vi.stubGlobal('fetch', (url: string) => {
      requests.push(url);
      const next = responses.shift();
      if (!next) throw new Error('Unexpected fetch');
      return next;
    });
    const oldPlay = bank.playUrl('custom.sound', 0.5);
    bank.forget('custom.');
    const newPlay = bank.playUrl('custom.sound', 0.25);
    newResponse.resolve(new Response(Uint8Array.from([4, 5, 6])));
    await newPlay;
    oldResponse.resolve(new Response(Uint8Array.from([1, 2, 3])));
    await oldPlay;
    bank.play('custom.sound', 0.75);
    expect(requests).toEqual(['custom.sound', 'custom.sound']);
    expect(contexts[0].started).toEqual([
      { bytes: [4, 5, 6], volume: 0.25 },
      { bytes: [4, 5, 6], volume: 0.75 },
    ]);
  });

  it('does not restore a sound forgotten while decoding and leaves other sounds alone', async () => {
    const bank = new SoundBank();
    const decoding = deferred<void>();
    const finish = deferred<void>();
    const decode = contexts[0].decodeAudioData.bind(contexts[0]);
    contexts[0].decodeAudioData = async (bytes) => {
      const buffer = await decode(bytes);
      decoding.resolve(undefined);
      await finish.promise;
      return buffer;
    };
    const discarded = bank.playUrl('custom.sound', 0.5);
    const kept = bank.playUrl('other.sound', 0.25);
    await decoding.promise;
    bank.forget('custom.');
    finish.resolve(undefined);
    await Promise.all([discarded, kept]);
    bank.play('custom.sound', 0.75);
    bank.play('other.sound', 0.75);
    expect(contexts[0].started.map((s) => s.volume)).toEqual([0.25, 0.75]);
  });

  it('keeps the latest URL when two pending loads use the same key', async () => {
    const bank = new SoundBank();
    const oldResponse = deferred<Response>();
    vi.stubGlobal('fetch', (url: string) => url === 'old.wav'
      ? oldResponse.promise : Promise.resolve(new Response(Uint8Array.from([4, 5, 6]))));
    const oldLoad = bank.load([{ key: 'ping', url: 'old.wav' }]);
    expect(await bank.load([{ key: 'ping', url: 'new.wav' }])).toEqual([]);
    oldResponse.resolve(new Response(Uint8Array.from([1, 2, 3])));
    expect(await oldLoad).toEqual(['old.wav']);
    bank.play('ping', 0.5);
    expect(contexts[0].started).toEqual([{ bytes: [4, 5, 6], volume: 0.5 }]);
  });

  it('keeps an already loaded sound available across muted playback', async () => {
    const bank = new SoundBank();
    await bank.playUrl('custom.sound', 0.5);
    await bank.playUrl('custom.sound', 0);
    await bank.playUrl('custom.sound', 0.75);
    expect(requests).toEqual(['custom.sound']);
    expect(contexts[0].decoded).toHaveLength(1);
    expect(contexts[0].started.map((s) => s.volume)).toEqual([0.5, 0.75]);
  });

  it('can retry a failed load and reload a sound after it is forgotten', async () => {
    const bank = new SoundBank();
    responseStatus = 404;
    await bank.playUrl('custom.sound', 0.5);
    expect(contexts[0].started).toEqual([]);
    responseStatus = 200;
    await bank.playUrl('custom.sound', 0.5);
    bank.forget('custom.');
    await bank.playUrl('custom.sound', 0.25);
    expect(contexts[0].decoded).toHaveLength(2);
    expect(contexts[0].started.map((s) => s.volume)).toEqual([0.5, 0.25]);
  });

  it('still caps overlapping voices and frees a voice when a sound ends', async () => {
    const bank = new SoundBank();
    await bank.load([{ key: 'ping', url: 'ping.wav' }]);
    for (let i = 0; i < MAX_VOICES + 1; i++) bank.play('ping', 0.5);
    expect(contexts[0].started).toHaveLength(MAX_VOICES);
    contexts[0].sources[0].onended?.();
    bank.play('ping', 0.5);
    expect(contexts[0].started).toHaveLength(MAX_VOICES + 1);
  });
});
