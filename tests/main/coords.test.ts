import { describe, expect, it } from 'vitest';
import {
  besideSpot, localToPhysical, physicalBoxToLocal, physicalToDip, physicalToLocal, placeInside, type DisplayMap,
} from '../../src/main/coords';

// Ultrawide primary at 100% + a 1080p monitor at 150% to its right + a 1440p monitor at 125% to its left.
const A: DisplayMap = { id: 1, scale: 1, dip: { x: 0, y: 0, width: 3440, height: 1440 }, phys: { x: 0, y: 0, width: 3440, height: 1440 } };
const B: DisplayMap = { id: 2, scale: 1.5, dip: { x: 3440, y: 0, width: 1280, height: 720 }, phys: { x: 3440, y: 0, width: 1920, height: 1080 } };
const C: DisplayMap = { id: 3, scale: 1.25, dip: { x: -2048, y: 0, width: 2048, height: 1152 }, phys: { x: -2560, y: 0, width: 2560, height: 1440 } };
const maps = [A, B, C];

describe('coords', () => {
  it('maps a point on the primary display unchanged', () => {
    expect(physicalToLocal(1000, 500, maps)).toEqual({ displayId: 1, x: 1000, y: 500 });
  });

  it('scales points on a high-DPI display', () => {
    expect(physicalToLocal(3440 + 300, 150, maps)).toEqual({ displayId: 2, x: 200, y: 100 });
    expect(physicalToDip(3440 + 300, 150, maps)).toMatchObject({ x: 3640, y: 100 });
  });

  it('localToPhysical undoes physicalToLocal on the same display', () => {
    for (const [x, y] of [[3440 + 300, 150], [-1280, 720], [1000, 500]]) {
      const l = physicalToLocal(x, y, maps)!;
      expect(localToPhysical(l.x, l.y, maps, l.displayId)).toEqual({ x, y });
    }
    expect(localToPhysical(1, 1, maps, 99)).toBeNull();
  });

  it('handles displays with negative origins', () => {
    expect(physicalToLocal(-1280, 720, maps)).toEqual({ displayId: 3, x: 1024, y: 576 });
  });

  it('physicalToLocal maps onto the wheel display across monitors', () => {
    // Wheel opened on A, cursor now on B: coordinates stay relative to A's overlay.
    expect(physicalToLocal(3440 + 300, 150, maps, 1)).toEqual({ displayId: 1, x: 3640, y: 100 });
  });

  it('uses the nearest display for points outside every display', () => {
    expect(physicalToLocal(1000, 2000, maps)).toEqual({ displayId: 1, x: 1000, y: 2000 });
  });

  it('returns null with no displays or an unknown target', () => {
    expect(physicalToLocal(0, 0, [])).toBeNull();
    expect(physicalToLocal(0, 0, maps, 99)).toBeNull();
  });

  it('maps a field box into the overlay of the display its centre is on, scaled to that display', () => {
    expect(physicalBoxToLocal({ x: 3440 + 300, y: 150, w: 600, h: 90 }, maps))
      .toEqual({ displayId: 2, x: 200, y: 100, w: 400, h: 60 });
    expect(physicalBoxToLocal({ x: -1280, y: 720, w: 250, h: 50 }, maps))
      .toEqual({ displayId: 3, x: 1024, y: 576, w: 200, h: 40 });
    // Its corner is on A, most of it on B: it is drawn on B, starting just left of B's edge.
    expect(physicalBoxToLocal({ x: 3440 - 30, y: 150, w: 600, h: 90 }, maps))
      .toEqual({ displayId: 2, x: -20, y: 100, w: 400, h: 60 });
    // Off every display: the nearest one.
    expect(physicalBoxToLocal({ x: 1000, y: 2000, w: 100, h: 20 }, maps))
      .toEqual({ displayId: 1, x: 1000, y: 2000, w: 100, h: 20 });
    expect(physicalBoxToLocal({ x: 0, y: 0, w: 10, h: 10 }, [])).toBeNull();
  });
});

describe('placeInside', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const box = { width: 420, height: 64 };

  it('keeps the wanted corner when the box fits', () => {
    expect(placeInside({ x: 100, y: 200 }, box, area)).toEqual({ x: 100, y: 200 });
  });

  it('pulls a box that would run off the right and bottom edges back in', () => {
    expect(placeInside({ x: 1900, y: 1030 }, box, area)).toEqual({ x: 1500, y: 976 });
  });

  it('pulls a box that starts left of or above the area onto its edge', () => {
    expect(placeInside({ x: -50, y: -5 }, box, { ...area, x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('works on a display that sits left of the primary', () => {
    expect(placeInside({ x: -100, y: 500 }, box, { x: -1920, y: 0, width: 1920, height: 1080 })).toEqual({ x: -420, y: 500 });
  });
});

describe('besideSpot', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const box = { width: 384, height: 200 };

  it('puts the box right of the spot, centred on it vertically', () => {
    expect(besideSpot({ x: 500, y: 400 }, box, area)).toEqual({ x: 516, y: 300, side: 'right' });
  });

  it('puts it left of the spot when the right side would run off the area', () => {
    expect(besideSpot({ x: 1700, y: 400 }, box, area)).toEqual({ x: 1300, y: 300, side: 'left' });
  });

  it('keeps it inside the area when the spot is near the top or bottom', () => {
    expect(besideSpot({ x: 500, y: 20 }, box, area)).toMatchObject({ y: 0, side: 'right' });
    expect(besideSpot({ x: 500, y: 1035 }, box, area)).toMatchObject({ y: 840, side: 'right' });
  });

  it('works on a display left of the primary', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    expect(besideSpot({ x: -100, y: 500 }, box, left)).toEqual({ x: -500, y: 400, side: 'left' });
  });
});
