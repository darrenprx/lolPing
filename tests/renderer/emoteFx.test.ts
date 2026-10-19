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
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void } = { setProperty: () => undefined };
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('EmoteStage', () => {
  it('reloads an evicted animation without revoking another owner’s live image', async () => {
    vi.useFakeTimers();
    const layer = new FakeElement('div');
    const large = new Blob([new Uint8Array(9 * 1024 * 1024)]);
    const reads: string[] = [];
    const stage = new EmoteStage(layer as unknown as HTMLElement, async (url) => {
      reads.push(url);
      return large;
    });
    stage.spawn('friend', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await vi.advanceTimersByTimeAsync(0);
    const friend = layer.find('emote')[0];
    const friendUrl = friend.find('sheet')[0].src;
    stage.spawn('self', { kind: 'bundled', slug: 'unworthy' }, 30, 40, { sizePx: 150 });
    await vi.advanceTimersByTimeAsync(0);
    stage.spawn('preview', { kind: 'bundled', slug: 'facepalm' }, 50, 60, { sizePx: 150 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(['../emotes/facepalm.webp', '../emotes/unworthy.webp', '../emotes/facepalm.webp']);
    expect(layer.find('emote')).toContain(friend);
    expect(friend.find('sheet')[0].src).toBe(friendUrl);
    expect((await (await fetch(friendUrl)).blob()).size).toBe(large.size);
    stage.clear('friend');
    await expect(fetch(friendUrl)).rejects.toThrow();
    expect(layer.find('emote')).toHaveLength(2);
    stage.clear('self');
    stage.clear('preview');
  });

  it('gives cached images separate URLs and revokes only the owner that ends', async () => {
    vi.useFakeTimers();
    const layer = new FakeElement('div');
    const bytes = new Blob(['animation']);
    const reads: string[] = [];
    const stage = new EmoteStage(layer as unknown as HTMLElement, async (url) => {
      reads.push(url);
      return bytes;
    });
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await vi.advanceTimersByTimeAsync(0);
    const firstUrl = layer.find('sheet')[0].src;
    stage.spawn('friend', { kind: 'bundled', slug: 'facepalm' }, 30, 40, { sizePx: 150 });
    await vi.advanceTimersByTimeAsync(0);
    const secondUrl = layer.find('sheet')[1].src;
    expect(secondUrl).not.toBe(firstUrl);
    expect(reads).toEqual(['../emotes/facepalm.webp']);
    stage.clear('self');
    await expect(fetch(firstUrl)).rejects.toThrow();
    expect(await (await fetch(secondUrl)).text()).toBe('animation');
    stage.clear('friend');
    await expect(fetch(secondUrl)).rejects.toThrow();
  });

  it('does not create an object URL when a cleared owner’s fetch finishes late', async () => {
    vi.useFakeTimers();
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    let finish: (blob: Blob) => void = () => { throw new Error('Uninitialized fetch'); };
    const pending = new Promise<Blob>((resolve) => { finish = resolve; });
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => pending);
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    stage.clear('self');
    finish(new Blob(['animation']));
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.find('emote')).toHaveLength(0);
    expect(createUrl.mock.results).toHaveLength(0);
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 30, 40, { sizePx: 150 });
    await vi.advanceTimersByTimeAsync(0);
    const url = layer.find('sheet')[0].src;
    expect(await (await fetch(url)).text()).toBe('animation');
    expect(createUrl.mock.results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3150);
    expect(layer.find('emote')).toHaveLength(0);
    await expect(fetch(url)).rejects.toThrow();
  });

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
    stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${hash}.webp`, animated: false, fx: 1 }, 10, 20, { sizePx: 150 });
    const [emote] = layer.find('emote');
    const [fx] = emote.find('fx');
    expect(fx.className.split(' ')).toEqual(['fx', 'v1']);
    expect(fx.children[0].tagName).toBe('img'); // the fake DOM finds by class only, so check the tag
    stage.clear('self');

    const other = '000b' + '0'.repeat(28);
    stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${other}.anim`, animated: true, fx: 2 }, 10, 20, { sizePx: 150 });
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
      stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${n.toString(16).repeat(16)}.webp`, animated: false, fx: n }, 10, 20, { sizePx: 150 });
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
