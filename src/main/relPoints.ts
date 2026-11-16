export interface ScreenPoint {
  x: number;
  y: number;
}

/** A pointer position older than this at the moment a gesture starts is not where the pointer is any more. */
const FRESH_MS = 500;

/**
 * Linux evdev only: the helper sees raw mouse counts, not screen positions (Wayland has no global cursor query).
 * This turns those counts into screen points, using the position the overlays see under the pointer while it is
 * wanted, and the gesture's start point plus the counts when they have not seen it. Pure: time comes in.
 */
export class RelPoints {
  private anchor: ScreenPoint | null = null;
  private startedAt = 0;
  /** The newest overlay pointer position, and when it came. Dropped when a gesture ends: the pointer moves unseen after. */
  private pointer: { at: ScreenPoint; time: number } | null = null;
  private lastRel: ScreenPoint = { x: 0, y: 0 };

  constructor(private readonly now: () => number) {}

  get active(): boolean {
    return this.anchor !== null;
  }

  /** The helper wants the pointer: a gesture may start. `fallback` is the best guess when no overlay has seen it. */
  begin(fallback: ScreenPoint): void {
    const t = this.now();
    this.startedAt = t;
    this.lastRel = { x: 0, y: 0 };
    this.anchor = this.pointer && t - this.pointer.time <= FRESH_MS ? this.pointer.at : fallback;
  }

  end(): void {
    this.anchor = null;
    this.pointer = null;
  }

  /** An overlay saw the pointer here. */
  pointerAt(at: ScreenPoint): void {
    this.pointer = { at, time: this.now() };
    // Keep anchor + counts on the same point, so the counts still land right if the overlays stop reporting.
    if (this.anchor) this.anchor = { x: at.x - this.lastRel.x, y: at.y - this.lastRel.y };
  }

  /** The screen point for counts measured from the gesture's press. */
  resolve(rel: ScreenPoint): ScreenPoint | null {
    if (!this.anchor) return null;
    this.lastRel = rel;
    if (this.pointer && this.pointer.time >= this.startedAt) return this.pointer.at;
    return { x: this.anchor.x + rel.x, y: this.anchor.y + rel.y };
  }
}
