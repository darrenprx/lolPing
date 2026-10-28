import { describe, expect, it, vi } from 'vitest';
import { RoomShotController, type ShotCrop } from '../../src/main/roomShotController';
import { DEFAULT_ROOM_SHOTS, type ShotMeta } from '../../src/shared/roomShots';

function harness() {
  let now = 0, nextId = 0, active = true;
  const settings = { ...DEFAULT_ROOM_SHOTS };
  const sent: ShotMeta[] = [];
  const capture = vi.fn(async (_crop: ShotCrop, _signal: AbortSignal): Promise<{ data: Uint8Array; w: number; h: number }> =>
    ({ data: Uint8Array.of(1, 2, 3), w: 640, h: 360 }));
  const cooldown = vi.fn(), watch = vi.fn();
  const ctl = new RoomShotController({ now: () => now, id: () => (++nextId).toString(16).padStart(16, '0'),
    settings: () => settings, canCapture: () => active,
    source: (id) => ({ displayId: id, number: id, scale: 1.5,
      bounds: { x: 0, y: 0, w: 1920, h: 1080 }, physical: { x: 0, y: 0, w: 2880, h: 1620 } }),
    capture, publish: (m) => sent.push(m), cooldown, watch });
  return { ctl, settings, sent, capture, cooldown, watch, at: (t: number) => { now = t; },
    active: (v: boolean) => { active = v; }, mark: (x = 500, y = 400, displayId = 1) => ctl.admit({ x, y, displayId }) };
}

describe('RoomShotController', () => {
  it('merges nearby consecutive pings and emotes into one group, growing its crop and keeping numbered marks', async () => {
    const h = harness();
    const first = h.mark(); h.at(100); const next = h.mark(1500, 900);
    expect(first).toMatchObject({ allowed: true, silent: false });
    expect(next).toMatchObject({ allowed: true, silent: true, batch: first.batch });
    h.at(400); h.ctl.tick();
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.capture.mock.calls[0][0].rect).toEqual({ x: 180, y: 220, w: 1384, h: 744 });
    expect(h.sent[0].marks.map((m) => m.n)).toEqual([1, 2]);
  });
  it('creates one group across screens, sends one crop per screen, and starts numbering again after the quiet gap', async () => {
    const h = harness(); const first = h.mark(); h.at(100); expect(h.mark(500, 500, 2).batch).toBe(first.batch);
    h.at(400); h.ctl.tick(); await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent.map((m) => m.d)).toEqual([1, 2]);
    h.at(1400); const newGroup = h.mark(); expect(newGroup.batch).not.toBe(first.batch);
    h.at(1700); h.ctl.tick(); await vi.waitFor(() => expect(h.sent).toHaveLength(3));
    expect(h.sent[2].marks.map((m) => m.n)).toEqual([1]);
  });
  it('rejects extra marks and retriggers feedback on every attempt without extending the cooldown', () => {
    const h = harness(); for (let i = 0; i < 5; i++) h.mark();
    expect(h.mark().allowed).toBe(false);
    h.at(1000); expect(h.mark().allowed).toBe(false);
    expect(h.cooldown.mock.calls).toEqual([[10_000, 1], [9000, 1]]);
    h.at(10_000); expect(h.mark().allowed).toBe(true);
  });
  it('does not capture outside a room, when no compatible peer is present, or when sending screenshots is off', () => {
    const h = harness(); h.active(false); h.mark(); h.at(500); h.ctl.tick(); expect(h.capture).not.toHaveBeenCalled();
    h.active(true); h.settings.enabled = false; h.mark(); h.at(900); h.ctl.tick(); expect(h.capture).not.toHaveBeenCalled();
  });
  it('drops a late capture after pause, room change or source content change and can capture the next group', async () => {
    const h = harness(); let resolve: ((v: { data: Uint8Array; w: number; h: number }) => void) | undefined;
    h.capture.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    h.mark(); h.at(300); h.ctl.tick(); h.ctl.invalidate();
    resolve?.({ data: Uint8Array.of(1), w: 640, h: 360 }); await Promise.resolve(); await Promise.resolve();
    expect(h.sent).toHaveLength(0);
    h.at(500); h.mark(); h.at(800); h.ctl.tick(); await vi.waitFor(() => expect(h.sent).toHaveLength(1));
  });
  it('never overwrites newer marks with a capture that finished after the group grew', async () => {
    const h = harness(); let resolve: ((v: { data: Uint8Array; w: number; h: number }) => void) | undefined;
    h.capture.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    h.mark(); h.at(300); h.ctl.tick(); h.at(400); h.mark(1200, 600);
    resolve?.({ data: Uint8Array.of(1), w: 640, h: 360 }); await Promise.resolve(); await Promise.resolve();
    expect(h.sent).toHaveLength(0);
    h.at(1300); h.ctl.tick(); await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0].rev).toBe(2);
  });
  it('keeps sending marks after capture failure or an oversized image, without silently sending a blurry replacement', async () => {
    const h = harness(); h.capture.mockRejectedValueOnce(new Error('denied'));
    expect(h.mark().allowed).toBe(true); h.at(300); h.ctl.tick();
    await vi.waitFor(() => expect(h.sent[0]?.status).toBe('capture'));
    h.capture.mockResolvedValueOnce({ data: new Uint8Array(524289), w: 640, h: 360 });
    h.at(1500); h.mark(); h.at(1800); h.ctl.tick();
    await vi.waitFor(() => expect(h.sent[1]?.status).toBe('large'));
    expect(h.sent[1].bytes).toBe(0);
    h.at(3100); h.mark(); h.at(3400); h.ctl.tick();
    await vi.waitFor(() => expect(h.sent[2]?.status).toBe('ready'));
  });
});
