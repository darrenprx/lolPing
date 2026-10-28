import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_SHOTS, growShot, MarkerGate, normalizeRoomShots, parseShotBody, shotPlacement } from '../../src/shared/roomShots';
import { normalizeSettings } from '../../src/shared/settings';
import { jpegSize } from '../../src/shared/jpegSize';

describe('MarkerGate', () => {
  it('accepts five mixed marks, rejects the sixth and recovers after ten seconds without queuing attempts', () => {
    let now = 100;
    const gate = new MarkerGate(() => now, () => DEFAULT_ROOM_SHOTS);
    for (let i = 0; i < 5; i++) { now += 100; expect(gate.admit().allowed).toBe(true); }
    expect(gate.admit()).toEqual({ allowed: false, started: true, remaining: 10_000 });
    now += 4000;
    expect(gate.admit()).toEqual({ allowed: false, started: false, remaining: 6000 });
    now += 6000;
    expect(gate.admit().allowed).toBe(true);
    expect(gate.remaining()).toBe(0);
  });
  it('uses a rolling window including its exact boundary and does not reset because a wall clock moved backwards', () => {
    let now = 1000;
    const gate = new MarkerGate(() => now, () => DEFAULT_ROOM_SHOTS);
    for (let i = 0; i < 5; i++) gate.admit();
    now = 6000;
    expect(gate.admit().allowed).toBe(true);
    for (let i = 0; i < 4; i++) gate.admit();
    gate.admit();
    now = -100;
    expect(gate.remaining()).toBe(10_000);
  });
});

describe('room screenshot settings and geometry', () => {
  it('migrates old settings with the approved defaults and gates the Windows feature on other platforms', () => {
    expect(normalizeSettings({}).roomShots).toEqual(DEFAULT_ROOM_SHOTS);
    expect(normalizeSettings({}, 'mac').roomShots.enabled).toBe(false);
    expect(normalizeSettings({}, 'linux').roomShots.receive).toBe(false);
  });
  it('bounds corrupted settings and preserves valid independent options', () => {
    const value = normalizeRoomShots({ width: Infinity, height: -5, maxMarks: 1e9, receive: false, placement: 'spot' });
    expect(value).toMatchObject({ width: 640, height: 90, maxMarks: 20, receive: false, placement: 'spot' });
  });
  it('starts at the default size and expands to retain every prior region', () => {
    const d = { x: 0, y: 0, w: 1920, h: 1080 };
    const first = growShot(null, { x: 500, y: 400 }, d, 640, 360);
    expect(first).toEqual({ x: 180, y: 220, w: 640, h: 360 });
    const next = growShot(first, { x: 1500, y: 900 }, d, 640, 360);
    expect(next).toEqual({ x: 180, y: 220, w: 1384, h: 744 });
    expect(growShot(next, { x: 600, y: 500 }, d, 640, 360)).toEqual(next);
  });
  it('clips the crop and popup at all screen edges and negative monitor origins', () => {
    expect(growShot(null, { x: 0, y: 0 }, { x: 0, y: 0, w: 1920, h: 1080 }, 640, 360))
      .toEqual({ x: 0, y: 0, w: 320, h: 180 });
    for (const mode of ['spot', 'corner'] as const) {
      const p = shotPlacement({ x: -1920, y: -100, width: 1280, height: 720 }, { x: -650, y: 610 }, mode, 2);
      expect(p.x).toBeGreaterThanOrEqual(-1920); expect(p.x + p.width).toBeLessThanOrEqual(-640);
      expect(p.y).toBeGreaterThanOrEqual(-100); expect(p.y + p.height).toBeLessThanOrEqual(620);
    }
  });
});

describe('screenshot message validation', () => {
  const meta = { t: 'shot', id: 'a'.repeat(16), rev: 1, d: 1, x: 0.5, y: 0.5,
    w: 640, h: 360, bytes: 100, hash: 'b'.repeat(64), marks: [{ x: 0.5, y: 0.5, n: 1 }], status: 'ready' };
  it('accepts the metadata and only bounded image parts and retransmission indexes', () => {
    expect(parseShotBody(meta)).toEqual(meta);
    expect(parseShotBody({ t: 'shotParts', id: meta.id, rev: 1, d: 1, to: 'c'.repeat(16), parts: [{ i: 0, b: 'YWJj' }] })).not.toBeNull();
    expect(parseShotBody({ t: 'shotWant', id: meta.id, rev: 1, d: 1, to: 'c'.repeat(16), need: [0, 0, 2] }))
      .toMatchObject({ need: [0, 2] });
  });
  it.each([{ bytes: 524289 }, { bytes: 0 }, { w: 8193 }, { x: NaN }, { rev: 0 }, { d: 17 },
    { hash: '../../image' }, { marks: [{ x: -1, y: 0, n: 1 }] }, { marks: Array(65).fill({ x: 0, y: 0, n: 1 }) }])
    ('rejects malformed metadata %j', (patch) => expect(parseShotBody({ ...meta, ...patch })).toBeNull());
  it('reads JPEG dimensions before decoding and rejects malformed or oversized frames', () => {
    const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 1, 104, 2, 128, 1, 1, 17, 0, 255, 217]);
    expect(jpegSize(jpeg)).toEqual({ w: 640, h: 360 });
    expect(jpegSize(jpeg.slice(0, 8))).toBeNull();
    jpeg[9] = 255; jpeg[10] = 255;
    expect(jpegSize(jpeg)).toBeNull();
  });
});
