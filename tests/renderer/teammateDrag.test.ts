// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PointerEvent } from 'react';
import type { MateDrag } from '../../src/shared/teammateIpc';
import { dragHandle } from '../../src/renderer/teammate/drag';

function event(x: number, y: number, opts: { button?: number; target?: Element; handle?: HTMLElement } = {}) {
  const handle = opts.handle ?? document.createElement('div');
  handle.setPointerCapture = vi.fn();
  const preventDefault = vi.fn();
  const pointer = {
    button: opts.button ?? 0, screenX: x, screenY: y, pointerId: 1,
    target: opts.target ?? handle, currentTarget: handle, preventDefault,
  } as unknown as PointerEvent;
  return { pointer, handle, preventDefault };
}

describe('dragHandle', () => {
  it('sends the offset from where the press began, until the press ends', () => {
    const sent: MateDrag[] = [];
    const h = dragHandle((d) => sent.push(d));
    const down = event(100, 100);
    h.onPointerDown(down.pointer);
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(down.handle.hasAttribute('data-mate-dragging')).toBe(true);
    h.onPointerMove(event(130, 90).pointer);
    h.onPointerUp(event(160, 120, { handle: down.handle }).pointer);
    expect(down.handle.hasAttribute('data-mate-dragging')).toBe(false);
    h.onPointerMove(event(200, 200).pointer);
    h.onLostPointerCapture(event(200, 200).pointer);
    expect(sent).toEqual([
      { phase: 'start', dx: 0, dy: 0 }, { phase: 'move', dx: 30, dy: -10 }, { phase: 'end', dx: 60, dy: 20 },
    ]);
  });

  it.each(['button', 'a', 'input', 'textarea', '[role="link"]', '[data-mate-text]'])(
    'leaves a press inside %s to its own selection or action', (selector) => {
      const sent: MateDrag[] = [];
      const h = dragHandle((d) => sent.push(d));
      const parent = document.createElement(selector.startsWith('[') ? 'span' : selector);
      if (selector === '[role="link"]') parent.setAttribute('role', 'link');
      if (selector === '[data-mate-text]') parent.setAttribute('data-mate-text', '');
      const target = parent.appendChild(document.createElement('span'));
      const down = event(100, 100, { target });
      h.onPointerDown(down.pointer);
      h.onPointerMove(event(130, 90).pointer);
      expect(sent).toEqual([]);
      expect(down.preventDefault).not.toHaveBeenCalled();
      expect(down.handle.hasAttribute('data-mate-dragging')).toBe(false);
    },
  );

  it('drags empty space beside text without selecting the text', () => {
    const sent: MateDrag[] = [];
    const h = dragHandle((d) => sent.push(d));
    const row = document.createElement('div');
    const text = row.appendChild(document.createElement('span'));
    text.setAttribute('data-mate-text', '');
    text.textContent = 'An answer';
    const down = event(100, 100, { target: row });
    h.onPointerDown(down.pointer);
    h.onPointerMove(event(120, 130).pointer);
    expect(sent).toEqual([{ phase: 'start', dx: 0, dy: 0 }, { phase: 'move', dx: 20, dy: 30 }]);
    expect(down.preventDefault).toHaveBeenCalledOnce();
  });

  it('leaves a right click alone', () => {
    const sent: MateDrag[] = [];
    const h = dragHandle((d) => sent.push(d));
    const down = event(100, 100, { button: 2 });
    h.onPointerDown(down.pointer);
    h.onPointerMove(event(130, 90).pointer);
    expect(sent).toEqual([]);
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it.each(['onPointerCancel', 'onLostPointerCapture'] as const)('ends a drag on %s', (end) => {
    const sent: MateDrag[] = [];
    const h = dragHandle((d) => sent.push(d));
    const down = event(100, 100);
    h.onPointerDown(down.pointer);
    h[end](event(110, 120, { handle: down.handle }).pointer);
    h.onPointerMove(event(130, 140).pointer);
    expect(sent).toEqual([{ phase: 'start', dx: 0, dy: 0 }, { phase: 'end', dx: 10, dy: 20 }]);
    expect(down.handle.hasAttribute('data-mate-dragging')).toBe(false);
  });
});
