import type { MateGlow } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import { expireMark } from './markLifetime';

/** How long a field's outline stays: it fades over this time, or holds still for it with reduced motion (the CSS). */
export const GLOW_MS = 900;

/** Outlines a field the teammate just wrote. One of its marks, so mate:clear and mate:fade take it too. */
export function spawnGlow(layer: HTMLElement, g: MateGlow): void {
  const el = document.createElement('div');
  el.className = 'mate-glow';
  el.dataset.owner = 'mate';
  el.style.left = `${g.box.x}px`;
  el.style.top = `${g.box.y}px`;
  el.style.width = `${g.box.w}px`;
  el.style.height = `${g.box.h}px`;
  el.style.setProperty('--glow', tagColorCss(g.color, g.rgb));
  layer.append(el);
  expireMark(el, GLOW_MS);
}

/** The glows of one display's overlay. A fill's later fields wait their delay; clear() drops those still waiting. */
export class GlowStage {
  private readonly pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly layer: HTMLElement) {}

  spawn(g: MateGlow): void {
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      spawnGlow(this.layer, g);
    }, g.delay);
    this.pending.add(timer);
  }

  /** A pause, mate:clear or a new ask: no field of the old answer lights up after it. */
  clear(): void {
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
  }
}
