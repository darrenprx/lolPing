import { growShot, MarkerGate, SHOT_MAX_BYTES, SHOT_MAX_MARKS, type RoomShotSettings, type ShotMeta } from '../shared/roomShots';
import type { Rect } from '../shared/teammate/coords';
import { shotHash } from './shotTransfer';

export interface ShotSource {
  displayId: number; number: number; bounds: Rect; physical: Rect; scale: number;
}
export interface ShotCrop {
  source: ShotSource; rect: Rect; marks: { x: number; y: number; n: number }[];
}
interface Group {
  id: string; rev: number; lastAt: number; due: number; lastCapture: number; sentRev: number;
  crops: Map<number, ShotCrop>;
}
export interface RoomShotControllerDeps {
  now(): number;
  id(): string;
  settings(): RoomShotSettings;
  source(displayId: number): ShotSource | null;
  canCapture(): boolean;
  capture(crop: ShotCrop, signal: AbortSignal): Promise<{ data: Uint8Array; w: number; h: number }>;
  publish(meta: ShotMeta, data: Uint8Array): void;
  cooldown(ms: number, displayId: number): void;
  watch(on: boolean): void;
}

/** One sender's accepted gestures. Captures never block admission, and cancelled generations never publish. */
export class RoomShotController {
  readonly gate: MarkerGate;
  private group: Group | null = null;
  private running: AbortController | null = null;
  private epoch = 0;
  private watching = false;
  constructor(private readonly deps: RoomShotControllerDeps) {
    this.gate = new MarkerGate(deps.now, deps.settings);
  }

  admit(p: { displayId: number; x: number; y: number }): { allowed: boolean; silent?: boolean; batch?: string } {
    const admitted = this.gate.admit();
    if (!admitted.allowed) {
      if (admitted.started) {
        if (this.group) this.group.due = this.deps.now();
      }
      this.deps.cooldown(admitted.remaining, p.displayId);
      return { allowed: false };
    }
    const now = this.deps.now(), s = this.deps.settings();
    let g = this.group;
    const count = g ? [...g.crops.values()].reduce((n, c) => n + c.marks.length, 0) : 0;
    const fresh = !g || now - g.lastAt > s.mergeMs || count >= SHOT_MAX_MARKS;
    if (fresh) {
      this.invalidate();
      g = { id: this.deps.id(), rev: 0, lastAt: now, due: Infinity, lastCapture: -Infinity, sentRev: 0, crops: new Map() };
      this.group = g;
    }
    if (!g) return { allowed: true };
    g.lastAt = now;
    g.rev++;
    const source = this.deps.source(p.displayId);
    if (source) {
      const old = g.crops.get(source.displayId);
      const rect = growShot(old?.rect ?? null, p, { x: 0, y: 0, w: source.bounds.w, h: source.bounds.h }, s.width, s.height);
      g.crops.set(source.displayId, { source, rect, marks: [...(old?.marks ?? []), { x: p.x, y: p.y, n: fresh ? 1 : count + 1 }] });
    }
    if (s.enabled && this.deps.canCapture() && source) {
      g.due = Math.max(now + 300, g.lastCapture + 1000);
      if (!this.watching) { this.watching = true; this.deps.watch(true); }
    }
    return { allowed: true, silent: !fresh, batch: g.id };
  }

  tick(): void {
    const g = this.group;
    if (!g || this.running) return;
    if (!this.deps.settings().enabled || !this.deps.canCapture()) {
      if (this.watching) this.invalidate();
      return;
    }
    if (g.rev === g.sentRev || this.deps.now() < g.due) {
      if (g.rev === g.sentRev && this.deps.now() - g.lastAt > this.deps.settings().mergeMs) this.stopWatch();
      return;
    }
    const abort = new AbortController();
    this.running = abort;
    const epoch = this.epoch, rev = g.rev;
    const crops = [...g.crops.values()].map((c) => ({ ...c, rect: { ...c.rect }, marks: c.marks.map((m) => ({ ...m })) }));
    g.lastCapture = this.deps.now();
    void this.capture(g, rev, crops, abort, epoch).finally(() => {
      if (this.running === abort) this.running = null;
    });
  }

  /** A scroll, window change, pause or room change ends the old coordinate frame immediately. */
  invalidate(): void {
    this.epoch++;
    this.running?.abort();
    this.group = null;
    this.stopWatch();
  }

  private stopWatch(): void {
    if (!this.watching) return;
    this.watching = false;
    this.deps.watch(false);
  }

  private async capture(g: Group, rev: number, crops: ShotCrop[], abort: AbortController, epoch: number): Promise<void> {
    for (const crop of crops) {
      let data: Uint8Array = new Uint8Array(), w = 1, h = 1;
      let status: ShotMeta['status'] = 'ready';
      try {
        const image = await this.deps.capture(crop, abort.signal);
        data = image.data; w = image.w; h = image.h;
        if (data.length === 0) status = 'capture';
        else if (data.length > SHOT_MAX_BYTES) { status = 'large'; data = new Uint8Array(); }
      } catch { status = 'capture'; }
      if (epoch !== this.epoch || abort.signal.aborted || g.rev !== rev || !this.deps.canCapture()) return;
      const mark = crop.marks.at(-1);
      if (!mark) continue;
      this.deps.publish({
        t: 'shot', id: g.id, rev, d: crop.source.number,
        x: mark.x / crop.source.bounds.w, y: mark.y / crop.source.bounds.h,
        w, h, bytes: data.length, hash: shotHash(data), status,
        marks: crop.marks.map((m) => ({ n: m.n,
          x: Math.max(0, Math.min(1, (m.x - crop.rect.x) / crop.rect.w)),
          y: Math.max(0, Math.min(1, (m.y - crop.rect.y) / crop.rect.h)),
        })),
      }, data);
    }
    if (epoch === this.epoch && g.rev === rev) g.sentRev = rev;
  }
}
