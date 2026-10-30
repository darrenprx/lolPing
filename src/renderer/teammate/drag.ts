import type { PointerEvent } from 'react';
import type { MateDrag } from '../../shared/teammateIpc';

/** What a press on the drag handle doesn't start: its buttons, links and text boxes keep their own clicks. */
const NOT_A_HANDLE = 'button, a, input, textarea, [role="link"], [data-mate-text]';

/**
 * Pointer handlers that drag the bubble or card by `send`ing the pointer's offset from where the press began. The
 * pointer is captured, so the drag goes on outside the window and while the window moves under it.
 */
export function dragHandle(send: (d: MateDrag) => void) {
  let from: { x: number; y: number } | null = null;
  let last = { dx: 0, dy: 0 };
  const offset = (e: PointerEvent): { dx: number; dy: number } =>
    (from ? { dx: e.screenX - from.x, dy: e.screenY - from.y } : { dx: 0, dy: 0 });
  const end = (e: PointerEvent, at = last): void => {
    if (!from) return;
    send({ phase: 'end', ...at });
    from = null;
    e.currentTarget.removeAttribute('data-mate-dragging');
  };
  return {
    onPointerDown(e: PointerEvent): void {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest(NOT_A_HANDLE))) return;
      // A background drag must not start the browser's text selection at the same time.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.setAttribute('data-mate-dragging', '');
      from = { x: e.screenX, y: e.screenY };
      last = { dx: 0, dy: 0 };
      send({ phase: 'start', dx: 0, dy: 0 });
    },
    onPointerMove(e: PointerEvent): void {
      if (!from) return;
      last = offset(e);
      send({ phase: 'move', ...last });
    },
    onPointerUp: (e: PointerEvent): void => end(e, offset(e)),
    // Capture-loss events can have zero screen coordinates: keep the last real position.
    onPointerCancel: (e: PointerEvent): void => end(e),
    onLostPointerCapture: (e: PointerEvent): void => end(e),
  };
}
