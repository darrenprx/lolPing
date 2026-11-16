import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextStage, type TextLine } from '../../src/renderer/overlay/textFx';

/** Just enough of the DOM for TextStage: elements with classes, styles and children that can be removed. */
class FakeElement {
  textContent = '';
  offsetWidth = 296;
  offsetHeight = 60;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  classes = new Set<string>();
  readonly style: Record<string, unknown> & { setProperty: (k: string, v: string) => void } = {
    setProperty: (k, v) => {
      this.style[k] = v;
    },
  };
  readonly classList = { remove: (c: string) => this.classes.delete(c) };
  set className(value: string) {
    this.classes = new Set(value.split(' '));
  }
  append(...els: FakeElement[]): void {
    for (const e of els) {
      e.parent = this;
      this.children.push(e);
    }
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

let layer: FakeElement;
let stage: TextStage;

const line = (over: Partial<TextLine> = {}): TextLine => ({ text: 'hi', x: 10, y: 20, owner: 'a', style: 'spot', ...over });
const waiting = (): number => layer.children.filter((c) => c.classes.has('wait')).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: () => new FakeElement() });
  vi.stubGlobal('window', { innerWidth: 1920, innerHeight: 136 }); // one 弹幕 lane
  layer = new FakeElement();
  stage = new TextStage(layer as unknown as HTMLElement, () => Date.now());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TextStage', () => {
  it('takes a spot bubble down after its display time', () => {
    stage.spawn(line({ text: 'ab' }));
    expect(layer.children).toHaveLength(1);
    vi.advanceTimersByTime(4119);
    expect(layer.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(layer.children).toHaveLength(0);
  });

  it('moves a spot bubble in when its point is near the top left corner', () => {
    stage.spawn(line({ x: 10, y: 20 }));
    expect(layer.children[0].style.left).toBe('156px'); // half the 296 px bubble plus the margin
    expect(layer.children[0].style.top).toBe('68px'); // the 60 px bubble sits above the point
  });

  it('measures a spot bubble where it will sit, since it shrinks and grows taller near the right edge', () => {
    vi.stubGlobal('document', {
      createElement: () => {
        const e = new FakeElement();
        // Like shrink-to-fit: right of x = 1500 the bubble is narrow, and a narrow bubble wraps to a taller one.
        Object.defineProperty(e, 'offsetWidth', { get: () => (parseFloat(String(e.style.left)) > 1500 ? 100 : 296) });
        Object.defineProperty(e, 'offsetHeight', { get: () => (parseFloat(String(e.style.left)) > 1500 ? 120 : 60) });
        return e;
      },
    });
    const shownLayer = new FakeElement();
    stage = new TextStage(shownLayer as unknown as HTMLElement, () => Date.now());
    stage.spawn(line({ x: 1900, y: 80 }));
    expect(shownLayer.children[0].style.left).toBe('1862px');
    expect(shownLayer.children[0].style.top).toBe('128px');
  });

  it('keeps three lines per owner and drops the oldest of a fourth', () => {
    for (const text of ['1', '2', '3', '4']) stage.spawn(line({ text }));
    expect(layer.children).toHaveLength(3);
    expect(layer.children.map((c) => c.children[0].textContent)).toEqual(['2', '3', '4']);
  });

  it('counts each owner apart', () => {
    for (const owner of ['a', 'b', 'c', 'd']) stage.spawn(line({ owner }));
    expect(layer.children).toHaveLength(4);
  });

  it('puts the name above a line from a member and none above our own', () => {
    stage.spawn(line({ tag: { name: 'Sam', color: 1 } }));
    stage.spawn(line({ owner: 'self' }));
    const [theirs, ours] = layer.children;
    expect(theirs.children.map((c) => c.textContent)).toEqual(['Sam', 'hi']);
    expect(ours.children.map((c) => c.textContent)).toEqual(['hi']);
  });

  it('holds a 弹幕 line until a lane is free, then starts it', () => {
    stage.spawn(line({ style: 'danmaku', owner: 'a', text: 'first' }));
    stage.spawn(line({ style: 'danmaku', owner: 'b', text: 'second' }));
    expect(waiting()).toBe(1);
    vi.advanceTimersByTime(1999); // (296 + 24) px at 160 px/s
    expect(waiting()).toBe(1);
    vi.advanceTimersByTime(2);
    expect(waiting()).toBe(0);
    expect(layer.children).toHaveLength(2);
  });

  it('takes a 弹幕 line down once it has crossed the screen', () => {
    stage.spawn(line({ style: 'danmaku' }));
    expect(layer.children).toHaveLength(1);
    vi.advanceTimersByTime(((1920 + 296) / 160) * 1000 + 1);
    expect(layer.children).toHaveLength(0);
  });

  it('draws 弹幕 lines at the size setting, with rows that grow with it', () => {
    vi.stubGlobal('window', { innerWidth: 1920, innerHeight: 400 }); // a quarter is 100 px: two 43 px rows, or three 34 px ones
    stage.setDanmaku({ sizePx: 28, speed: 1 });
    for (const owner of ['a', 'b', 'c']) stage.spawn(line({ style: 'danmaku', owner }));
    expect(layer.children[0].style.fontSize).toBe('28px');
    expect(layer.children[0].style.lineHeight).toBe('43px');
    expect(layer.children.map((c) => c.style.top)).toEqual(['0px', '43px', undefined]);
    expect(waiting()).toBe(1);
  });

  it('moves 弹幕 lines at the speed setting, and lines on screen keep theirs', () => {
    stage.setDanmaku({ sizePx: 22, speed: 2 });
    stage.spawn(line({ style: 'danmaku', owner: 'a' }));
    expect(layer.children[0].style['--dur']).toBe(`${((1920 + 296) / 320) * 1000}ms`);
    stage.setDanmaku({ sizePx: 22, speed: 1 });
    vi.advanceTimersByTime(((1920 + 296) / 320) * 1000 + 1);
    expect(layer.children).toHaveLength(0);
  });

  it('drops the oldest 弹幕 line past the cap, and its lane stays reserved for the gap behind it', () => {
    stage.spawn(line({ style: 'danmaku', text: 'on screen' }));
    for (const text of ['w1', 'w2', 'w3']) stage.spawn(line({ style: 'danmaku', text }));
    expect(layer.children.map((c) => c.children[0].textContent)).toEqual(['w1', 'w2', 'w3']);
    expect(waiting()).toBe(3);
    vi.advanceTimersByTime(2001);
    expect(waiting()).toBe(2);
  });
});
