// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockedHint } from '../../src/renderer/overlay/blockedHint';
import { IDLE_MS, IdleWatch } from '../../src/renderer/overlay/idleWatch';

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
afterEach(() => {
  document.body.replaceChildren();
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(Element.prototype, 'animate');
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('blockedHint', () => {
  it('lets an overlay become idle before the first notice and again when a notice finishes', () => {
    vi.useFakeTimers();
    const layer = document.createElement('div');
    document.body.append(layer);
    let finish: (() => void) | null = null;
    Object.defineProperty(layer.ownerDocument.defaultView?.Element.prototype, 'animate', {
      configurable: true, value: () => {
        const animation = { cancel: () => undefined, onfinish: null as (() => void) | null };
        finish = () => animation.onfinish?.();
        return animation;
      },
    });
    const show = blockedHint(layer);
    const reports: boolean[] = [];
    const idle = new IdleWatch(() => layer.childElementCount === 0, (value) => reports.push(value));
    idle.check();
    vi.advanceTimersByTime(IDLE_MS);
    expect(reports).toEqual([true]);
    show('blocked');
    idle.check();
    expect(reports).toEqual([true, false]);
    expect(layer.childElementCount).toBe(1);
    const completed = finish as (() => void) | null;
    completed?.();
    expect(layer.childElementCount).toBe(0);
    idle.check();
    vi.advanceTimersByTime(IDLE_MS);
    expect(reports).toEqual([true, false, true]);
  });
  it('reuses one notice and ignores the previous animation finishing after a retrigger', () => {
    const layer = document.createElement('div');
    document.body.append(layer);
    const animations: { onfinish: (() => void) | null; cancel(): void }[] = [];
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => {
      const animation = { cancel: () => undefined, onfinish: null as (() => void) | null };
      animations.push(animation);
      return animation;
    } });
    const show = blockedHint(layer);
    show('first'); show('second');
    animations[0].onfinish?.();
    expect(layer.childElementCount).toBe(1);
    expect(layer.textContent).toBe('second');
    animations[1].onfinish?.();
    expect(layer.childElementCount).toBe(0);
  });
});
