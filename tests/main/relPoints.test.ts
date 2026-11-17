import { describe, expect, it } from 'vitest';
import { RelPoints } from '../../src/main/relPoints';

function make() {
  let t = 1000;
  const rp = new RelPoints(() => t);
  return { rp, tick: (ms: number) => { t += ms; } };
}

describe('RelPoints', () => {
  it('gives nothing while no gesture is on', () => {
    const { rp } = make();
    expect(rp.resolve({ x: 5, y: 5 })).toBeNull();
    expect(rp.active).toBe(false);
  });

  it('adds the counts to the fallback point when no overlay has seen the pointer', () => {
    const { rp } = make();
    rp.begin({ x: 100, y: 200 });
    expect(rp.resolve({ x: 0, y: 0 })).toEqual({ x: 100, y: 200 });
    expect(rp.resolve({ x: 30, y: -10 })).toEqual({ x: 130, y: 190 });
  });

  it('prefers the newest overlay pointer position reported after the gesture started', () => {
    const { rp, tick } = make();
    rp.begin({ x: 100, y: 200 });
    tick(10);
    rp.pointerAt({ x: 640, y: 480 });
    expect(rp.resolve({ x: 30, y: -10 })).toEqual({ x: 640, y: 480 });
    tick(10);
    rp.pointerAt({ x: 650, y: 470 });
    expect(rp.resolve({ x: 40, y: -20 })).toEqual({ x: 650, y: 470 });
  });

  it('keeps counts and pointer consistent: a pointer seen mid-gesture moves the anchor', () => {
    const { rp } = make();
    rp.begin({ x: 0, y: 0 });
    rp.resolve({ x: 20, y: 10 });
    rp.pointerAt({ x: 520, y: 310 });
    expect(rp.resolve({ x: 20, y: 10 })).toEqual({ x: 520, y: 310 });
  });

  it('forgets the pointer when the gesture ends', () => {
    const { rp } = make();
    rp.begin({ x: 0, y: 0 });
    rp.pointerAt({ x: 9, y: 9 });
    rp.end();
    expect(rp.active).toBe(false);
    expect(rp.resolve({ x: 1, y: 1 })).toBeNull();
    rp.begin({ x: 50, y: 60 });
    expect(rp.resolve({ x: 1, y: 1 })).toEqual({ x: 51, y: 61 });
  });

  it('anchors a repeated begin on a fresh pointer position, not a stale one', () => {
    const fresh = make();
    fresh.rp.begin({ x: 0, y: 0 });
    fresh.rp.pointerAt({ x: 300, y: 300 });
    fresh.tick(100);
    fresh.rp.begin({ x: 1, y: 1 });
    expect(fresh.rp.resolve({ x: 0, y: 0 })).toEqual({ x: 300, y: 300 });

    const stale = make();
    stale.rp.begin({ x: 0, y: 0 });
    stale.rp.pointerAt({ x: 300, y: 300 });
    stale.tick(2000);
    stale.rp.begin({ x: 1, y: 1 });
    expect(stale.rp.resolve({ x: 5, y: 5 })).toEqual({ x: 6, y: 6 });
  });
});
