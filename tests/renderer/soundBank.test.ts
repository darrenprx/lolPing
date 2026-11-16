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

describe('SoundBank', () => {
  it.each([0, -0.5])('does no loading or playback when the requested volume is %s', async (volume) => {
    const bank = new SoundBank();
    await Promise.all(Array.from({ length: 8 }, () => bank.playUrl('custom.sound', volume)));
    expect(requests).toEqual([]);
    expect(contexts[0].decoded).toEqual([]);
    expect(contexts[0].started).toEqual([]);
  });

  it('loads and plays normally after a muted first use', async () => {
    const bank = new SoundBank();
    await bank.playUrl('custom.sound', 0);
    await bank.playUrl('custom.sound', 0.5);
    await bank.playUrl('custom.sound', 0.25);
    expect(requests).toEqual(['custom.sound']);
    expect(contexts[0].decoded).toEqual([{ bytes: [1, 2, 3] }]);
    expect(contexts[0].started).toEqual([
      { bytes: [1, 2, 3], volume: 0.5 },
      { bytes: [1, 2, 3], volume: 0.25 },
    ]);
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
