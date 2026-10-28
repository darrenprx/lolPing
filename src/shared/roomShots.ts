import type { Rect } from './teammate/coords';

export interface RoomShotSettings {
  enabled: boolean;
  receive: boolean;
  placement: 'corner' | 'spot';
  width: number;
  height: number;
  mergeMs: number;
  windowMs: number;
  maxMarks: number;
  cooldownMs: number;
  lifetimeMs: number;
}

export const DEFAULT_ROOM_SHOTS: RoomShotSettings = {
  enabled: true, receive: true, placement: 'corner', width: 640, height: 360,
  mergeMs: 1200, windowMs: 5000, maxMarks: 5, cooldownMs: 10_000, lifetimeMs: 10_000,
};

export const SHOT_MAX_BYTES = 512 * 1024;
export const SHOT_MAX_MARKS = 64;
export const SHOT_CHUNK_BYTES = 600;
export const SHOT_MAX_CHUNKS = Math.ceil(SHOT_MAX_BYTES / SHOT_CHUNK_BYTES);
export const SHOT_MAX_ASSEMBLIES = 8;
export const SHOT_ID_RE = /^[0-9a-f]{16}$/;
export const SHOT_HASH_RE = /^[0-9a-f]{64}$/;

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min: number, max: number): v is number => number(v, min, max) && Number.isInteger(v);

/** Old and malformed files get bounded defaults, without changing any unrelated setting. */
export function normalizeRoomShots(raw: unknown): RoomShotSettings {
  const r = object(raw) ? raw : {};
  const n = (key: keyof RoomShotSettings, min: number, max: number): number => {
    const v = r[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(min, Math.min(max, v)))
      : Number(DEFAULT_ROOM_SHOTS[key]);
  };
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    receive: typeof r.receive === 'boolean' ? r.receive : true,
    placement: r.placement === 'spot' ? 'spot' : 'corner',
    width: n('width', 160, 1920), height: n('height', 90, 1080), mergeMs: n('mergeMs', 300, 3000),
    windowMs: n('windowMs', 1000, 30_000), maxMarks: n('maxMarks', 1, 20),
    cooldownMs: n('cooldownMs', 1000, 60_000), lifetimeMs: n('lifetimeMs', 3000, 60_000),
  };
}

/** Monotonic sender-side admission: denied attempts never extend a cooldown or enter a queue. */
export class MarkerGate {
  private times: number[] = [];
  private until = 0;
  private last = 0;
  constructor(private readonly now: () => number, private readonly settings: () => RoomShotSettings) {}

  remaining(): number { return Math.max(0, this.until - this.clock()); }

  admit(): { allowed: boolean; started: boolean; remaining: number } {
    const now = this.clock();
    if (now < this.until) return { allowed: false, started: false, remaining: this.until - now };
    if (this.until) { this.until = 0; this.times = []; }
    const s = this.settings();
    this.times = this.times.filter((t) => t > now - s.windowMs);
    if (this.times.length >= s.maxMarks) {
      this.until = now + s.cooldownMs;
      return { allowed: false, started: true, remaining: s.cooldownMs };
    }
    this.times.push(now);
    return { allowed: true, started: false, remaining: 0 };
  }

  private clock(): number { this.last = Math.max(this.last, this.now()); return this.last; }
}

/** A group grows without dropping the old area, clamped to its source display. Units are DIPs. */
export function growShot(old: Rect | null, p: { x: number; y: number }, display: Rect, width: number, height: number): Rect {
  const initial = { x: p.x - width / 2, y: p.y - height / 2, w: width, h: height };
  const base = old ?? initial;
  const pad = old ? 64 : 0;
  const left = Math.max(display.x, Math.min(base.x, p.x - pad));
  const top = Math.max(display.y, Math.min(base.y, p.y - pad));
  const right = Math.min(display.x + display.w, Math.max(base.x + base.w, p.x + pad));
  const bottom = Math.min(display.y + display.h, Math.max(base.y + base.h, p.y + pad));
  return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
}

export interface ShotMark { x: number; y: number; n: number }
export interface ShotMeta {
  t: 'shot';
  id: string;
  rev: number;
  d: number;
  x: number;
  y: number;
  w: number;
  h: number;
  bytes: number;
  hash: string;
  marks: ShotMark[];
  status: 'ready' | 'capture' | 'large';
}
export interface ShotParts {
  t: 'shotParts'; id: string; rev: number; d: number; to: string;
  parts: { i: number; b: string }[];
}
export interface ShotWant {
  t: 'shotWant'; id: string; rev: number; d: number; to: string; need: number[];
}
export type ShotBody = ShotMeta | ShotParts | ShotWant;

/** Format-two messages are bounded before allocating image storage or decoding an image. */
export function parseShotBody(raw: unknown): ShotBody | null {
  if (!object(raw)) return null;
  const { t, id, rev, d } = raw;
  if (typeof id !== 'string' || !SHOT_ID_RE.test(id) || !integer(rev, 1, 1_000_000) || !integer(d, 1, 16)) return null;
  const base = { id, rev, d };
  if (t === 'shot') {
    const { x, y, w, h, bytes, hash, marks, status } = raw;
    if (!number(x, 0, 1) || !number(y, 0, 1) || !integer(w, 1, 8192) || !integer(h, 1, 8192)
      || w * h > 32_000_000 || !integer(bytes, 0, SHOT_MAX_BYTES) || typeof hash !== 'string'
      || !SHOT_HASH_RE.test(hash) || !Array.isArray(marks) || marks.length > SHOT_MAX_MARKS
      || (status !== 'ready' && status !== 'capture' && status !== 'large')) return null;
    if (status === 'ready' && bytes === 0) return null;
    const points: ShotMark[] = [];
    for (const m of marks) {
      if (!object(m) || !number(m.x, 0, 1) || !number(m.y, 0, 1) || !integer(m.n, 1, 1_000_000)) return null;
      points.push({ x: m.x, y: m.y, n: m.n });
    }
    return { t, ...base, x, y, w, h, bytes, hash, marks: points, status };
  }
  const { to } = raw;
  if (typeof to !== 'string' || !SHOT_ID_RE.test(to)) return null;
  if (t === 'shotWant') {
    if (!Array.isArray(raw.need) || raw.need.length > 64 || !raw.need.every((i) => integer(i, 0, SHOT_MAX_CHUNKS - 1))) return null;
    return { t, ...base, to, need: [...new Set(raw.need)] };
  }
  if (t === 'shotParts') {
    if (!Array.isArray(raw.parts) || raw.parts.length < 1 || raw.parts.length > 16) return null;
    const parts: ShotParts['parts'] = [];
    for (const p of raw.parts) {
      if (!object(p) || !integer(p.i, 0, SHOT_MAX_CHUNKS - 1) || typeof p.b !== 'string'
        || p.b.length < 4 || p.b.length > 800 || p.b.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.b)) return null;
      parts.push({ i: p.i, b: p.b });
    }
    return { t, ...base, to, parts };
  }
  return null;
}

/** A small card stays within a display's usable desktop; corner cards stack upwards. */
export function shotPlacement(area: { x: number; y: number; width: number; height: number },
  at: { x: number; y: number }, mode: 'spot' | 'corner', index = 0): { x: number; y: number; width: number; height: number } {
  const width = Math.min(352, area.width), height = Math.min(266, area.height);
  const x = mode === 'corner' ? area.x + area.width - width - 16 : at.x + 24;
  const y = mode === 'corner' ? area.y + area.height - height - 16 - index * (height + 12) : at.y + 24;
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width, height };
}
