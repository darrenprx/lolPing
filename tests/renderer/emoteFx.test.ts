import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emoteFxContent } from '../../src/renderer/shared/emoteFx';
import { EmoteStage } from '../../src/renderer/overlay/emoteStage';

/** Just enough of the DOM for EmoteStage: elements with classes, children, text and a src. */
class FakeElement {
  className = '';
  textContent = '';
  src = '';
  alt = '';
  draggable = true;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void } = {
    setProperty(k: string, v: string): void { this[k] = v; },
  };
  constructor(readonly tagName: string) {}
  append(...els: FakeElement[]): void {
    for (const el of els) {
      el.remove();
      el.parent = this;
      this.children.push(el);
    }
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceWith(el: FakeElement): void {
    const p = this.parent;
    if (!p) return;
    p.children[p.children.indexOf(this)] = el;
    el.parent = p;
    this.parent = null;
  }
  private readonly listeners = new Map<string, Array<{ fn: () => void; once: boolean }>>();
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, once: opts?.once === true }]);
  }
  /** Runs this element's listeners for `type`, dropping the ones registered with `once`. */
  dispatch(type: string): void {
    const all = this.listeners.get(type) ?? [];
    this.listeners.set(type, all.filter((l) => !l.once));
    for (const l of all) l.fn();
  }
  /** Every element under this one with `cls` among its classes. */
  find(cls: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.className.split(' ').includes(cls) ? [c] : []), ...c.find(cls)]);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmoteStage', () => {
  it('shows the placeholder when a bundled emote’s animation arrives but cannot be decoded', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['not a webp'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    const [sheet] = emote.find('sheet');
    expect(sheet.src).toMatch(/^blob:/);
    sheet.dispatch('error'); // the <img> could not decode what it was given
    expect(emote.find('sheet')).toHaveLength(0);
    const [fx] = emote.find('fx'); // the same envelope as a custom emote or a missing file
    expect(fx.find('bubble')).toHaveLength(1);
    expect(layer.find('emote')).toHaveLength(1); // still on screen for its 3 s
    sheet.dispatch('error'); // a second error does not swap again
    expect(emote.find('fx')).toHaveLength(1);
    expect(emote.find('bubble')).toHaveLength(1);
    stage.clear('self');
    expect(layer.find('emote')).toHaveLength(0);
  });

  it('a decode error after the emote was cleared does nothing', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    const [sheet] = emote.find('sheet');
    stage.clear('self');
    sheet.dispatch('error');
    expect(emote.find('fx')).toHaveLength(0);
    expect(emote.find('bubble')).toHaveLength(0);
    expect(layer.find('emote')).toHaveLength(0);
  });

  it('a decode error after a newer emote replaced this one leaves the newer emote alone', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [old] = layer.find('emote');
    const [oldSheet] = old.find('sheet');
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 30, 40, { sizePx: 150 });
    await flush();
    oldSheet.dispatch('error');
    const emotes = layer.find('emote');
    expect(emotes).toHaveLength(1);
    expect(emotes[0]).not.toBe(old);
    expect(emotes[0].find('sheet')).toHaveLength(1);
    expect(emotes[0].find('bubble')).toHaveLength(0);
    stage.clear('self');
  });

  it('shows a bundled emote’s baked animation', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    expect(emote.find('sheet')).toHaveLength(1);
    expect(emote.find('sheet')[0].src).toMatch(/^blob:/);
    expect(emote.find('bubble')).toHaveLength(0);
    stage.clear('self');
  });

  it('shows the placeholder when a bundled emote’s animation is missing', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.reject(new Error('404')));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const emotes = layer.find('emote');
    expect(emotes).toHaveLength(1); // still on screen for its 3 s
    expect(emotes[0].find('sheet')).toHaveLength(0);
    const [fx] = emotes[0].find('fx'); // the same envelope as a custom emote
    expect(fx.find('bubble')).toHaveLength(1);
    stage.clear('self');
    expect(layer.find('emote')).toHaveLength(0);
  });

  it('a missing animation that arrives after the emote was cleared does nothing', async () => {
    const layer = new FakeElement('div');
    let fail: (e: Error) => void = () => undefined;
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => new Promise((_, reject) => (fail = reject)));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    stage.clear('self');
    fail(new Error('404'));
    await flush();
    expect(layer.find('emote')).toHaveLength(0);
  });
});

describe('custom emote effects', () => {
  it('plays an imported emote in the envelope its entry picks', () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement);
    const hash = '000a' + '0'.repeat(28);
    stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${hash}.webp`, still: `lolping://emotes/${hash}.webp`, animated: false, fx: 1 }, 10, 20, { sizePx: 150 });
    const [emote] = layer.find('emote');
    const [fx] = emote.find('fx');
    expect(fx.className.split(' ')).toEqual(['fx', 'v1']);
    expect(fx.children[0].tagName).toBe('img'); // the fake DOM finds by class only, so check the tag
    stage.clear('self');

    const other = '000b' + '0'.repeat(28);
    stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${other}.anim`, still: `lolping://emotes/${other}.webp`, animated: true, fx: 2 }, 10, 20, { sizePx: 150 });
    expect(layer.find('emote')[0].find('fx')[0].className.split(' ')).toEqual(['fx', 'v2']);
    stage.clear('self');
  });

  it('keeps the plain envelope for the placeholder, whatever the URL looks like', () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement);
    stage.spawn('self', { kind: 'placeholder' }, 10, 20, { sizePx: 150 });
    const [fx] = layer.find('emote')[0].find('fx');
    expect(fx.className.split(' ')).toEqual(['fx', 'v0']);
    expect(fx.find('bubble')).toHaveLength(1);
    stage.clear('self');
  });
});

describe('plain effects', () => {
  it('add nothing around the art, and neither does the placeholder', () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement);
    for (let n = 0; n < 6; n++) {
      stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${n.toString(16).repeat(16)}.webp`, still: `lolping://emotes/${n.toString(16).repeat(16)}.webp`, animated: false, fx: n }, 10, 20, { sizePx: 150 });
      const [fx] = layer.find('emote')[0].find('fx');
      expect(fx.children.filter((c) => c.tagName === 'i')).toHaveLength(0);
      stage.clear('self');
    }
    stage.spawn('self', { kind: 'placeholder' }, 10, 20, { sizePx: 150 });
    expect(layer.find('emote')[0].find('fx')[0].children.filter((c) => c.tagName === 'i')).toHaveLength(0);
    stage.clear('self');
  });
});

describe('emoteFxContent (the effect picker builds the same nodes)', () => {
  const url = 'lolping://emotes/still/0123456789abcdef0123456789abcdef.webp';

  it('variant 0 is just the art in the plain envelope, with no ornaments', () => {
    const fx = emoteFxContent(0, url) as unknown as FakeElement;
    expect(fx.className).toBe('fx v0');
    expect(fx.children).toHaveLength(1); // the art, nothing else
    expect(fx.find('blob')).toHaveLength(0);
    expect(fx.find('ring')).toHaveLength(0);
    expect(fx.find('spark')).toHaveLength(0);
  });

  it('an art that cannot load falls back to the placeholder bubble', () => {
    const fx = emoteFxContent(5, url) as unknown as FakeElement;
    fx.children[0].dispatch('error');
    expect(fx.find('bubble')).toHaveLength(1);
  });
});

/** A tiny animated GIF with one frame per delay, that many centiseconds long. */
const GIF_TIMED = (...delays: number[]): Uint8Array<ArrayBuffer> =>
  Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 4, 0, 0, 0, 0,
    ...delays.flatMap((cs) => [0x21, 0xf9, 4, 0, cs & 0xff, (cs >> 8) & 0xff, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0x2c, 0]),
    0x3b]);

const ANIM_URL = `lolping://emotes/${'a'.repeat(32)}.anim`;
const STILL_URL = `lolping://emotes/${'a'.repeat(32)}.webp`;
const animated = (fx = 0): Parameters<EmoteStage['spawn']>[1] => ({
  kind: 'custom', url: ANIM_URL, still: STILL_URL, animated: true, fx,
});

describe('a custom animation (one loop of its file, then a frozen hold)', () => {
  it('plays one loop, freezes on the still for the hold, and is gone after', async () => {
    vi.useFakeTimers();
    try {
      const layer = new FakeElement('div');
      const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob([GIF_TIMED(50, 25)])));
      stage.spawn('self', animated(), 10, 20, { sizePx: 150 });
      await vi.advanceTimersByTimeAsync(0); // the bytes arrive: one 0.75 s loop plus the 0.4 s hold
      const [emote] = layer.find('emote');
      expect(emote.style['--dur']).toBe('1.15s');
      const img = emote.find('fx')[0].children[0];
      expect(img.src).toMatch(/^blob:/);
      await vi.advanceTimersByTimeAsync(750); // the loop ends: the art freezes on the imported still
      expect(img.src).toBe(STILL_URL);
      expect(layer.find('emote')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(550); // the hold runs out, 150 ms after the 0.35 s goodbye
      expect(layer.find('emote')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a loop longer than the default keeps the default', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob([GIF_TIMED(250, 250)])));
    stage.spawn('self', animated(2), 10, 20, { sizePx: 150 });
    await flush();
    expect(layer.find('emote')[0].style['--dur']).toBe('3s');
    expect(layer.find('emote')[0].find('fx')[0].className.split(' ')).toEqual(['fx', 'v2']); // its effect still plays
    stage.clear('self');
  });

  it('a loop shorter than an effect needs keeps the shortest time', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob([GIF_TIMED(10, 10)])));
    stage.spawn('self', animated(), 10, 20, { sizePx: 150 });
    await flush();
    expect(layer.find('emote')[0].style['--dur']).toBe('0.6s');
    stage.clear('self');
  });

  it('a file with no measurable loop keeps the default time, from its own object URL all the same', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['not an animation'])));
    stage.spawn('self', animated(), 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    expect(emote.style['--dur']).toBe('3s');
    expect(emote.find('fx')[0].children[0].src).toMatch(/^blob:/);
    stage.clear('self');
  });

  it('a file we cannot fetch plays the shared URL for the default time', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.reject(new Error('404')));
    stage.spawn('self', animated(4), 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    expect(emote.style['--dur']).toBe('3s');
    expect(emote.find('fx')[0].children[0].src).toBe(ANIM_URL);
    stage.clear('self');
    expect(layer.find('emote')).toHaveLength(0);
  });
});
