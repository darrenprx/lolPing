export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The top-left corner for a box of `size` that wants to sit at `at` but has to stay inside `area`. */
export function placeInside(at: { x: number; y: number }, size: { width: number; height: number }, area: Rect): { x: number; y: number } {
  const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(v, max));
  return {
    x: clamp(at.x, area.x, area.x + area.width - size.width),
    y: clamp(at.y, area.y, area.y + area.height - size.height),
  };
}

/** Space between the spot and a box placed beside it. */
const SPOT_GAP = 16;

/**
 * Where a box of `size` sits beside a spot: right of it, or left when the right side would leave `area`, vertically
 * centred on it and kept inside `area`. `side` is the side of the spot the box is on.
 */
export function besideSpot(
  spot: { x: number; y: number }, size: { width: number; height: number }, area: Rect,
): { x: number; y: number; side: 'left' | 'right' } {
  const side = spot.x + SPOT_GAP + size.width <= area.x + area.width ? 'right' : 'left';
  const x = side === 'right' ? spot.x + SPOT_GAP : spot.x - SPOT_GAP - size.width;
  return { ...placeInside({ x, y: spot.y - size.height / 2 }, size, area), side };
}

/** One monitor: its rect in DIPs (Electron) and in physical pixels (the hook helper). */
export interface DisplayMap {
  id: number;
  dip: Rect;
  phys: Rect;
  scale: number;
}

export interface LocalPoint {
  displayId: number;
  x: number;
  y: number;
}

const contains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

function distSq(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.width - 1));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.height - 1));
  return dx * dx + dy * dy;
}

export function displayAtPhysical(x: number, y: number, maps: readonly DisplayMap[]): DisplayMap | null {
  if (maps.length === 0) return null;
  return maps.find((m) => contains(m.phys, x, y)) ?? maps.reduce((a, b) => (distSq(b.phys, x, y) < distSq(a.phys, x, y) ? b : a));
}

/** Physical screen pixels → global DIP coordinates, using the display under the point. */
export function physicalToDip(x: number, y: number, maps: readonly DisplayMap[]): { display: DisplayMap; x: number; y: number } | null {
  const d = displayAtPhysical(x, y, maps);
  if (!d) return null;
  return { display: d, x: d.dip.x + (x - d.phys.x) / d.scale, y: d.dip.y + (y - d.phys.y) / d.scale };
}

/** Physical point → CSS pixels inside the overlay of `displayId` (default: the display under the point). */
export function physicalToLocal(x: number, y: number, maps: readonly DisplayMap[], displayId?: number): LocalPoint | null {
  const p = physicalToDip(x, y, maps);
  if (!p) return null;
  const target = displayId === undefined ? p.display : maps.find((m) => m.id === displayId);
  if (!target) return null;
  return { displayId: target.id, x: p.x - target.dip.x, y: p.y - target.dip.y };
}

/**
 * A physical box → CSS pixels inside the overlay of the display its centre is on (the nearest one when it is on
 * none), sized by that display's scale. A box that spans two displays is drawn on the one that holds most of it.
 */
export function physicalBoxToLocal(
  box: { x: number; y: number; w: number; h: number }, maps: readonly DisplayMap[],
): (LocalPoint & { w: number; h: number }) | null {
  const d = displayAtPhysical(box.x + box.w / 2, box.y + box.h / 2, maps);
  if (!d) return null;
  return {
    displayId: d.id, x: (box.x - d.phys.x) / d.scale, y: (box.y - d.phys.y) / d.scale, w: box.w / d.scale,
    h: box.h / d.scale,
  };
}

/** The inverse of physicalToLocal: a point in CSS px inside the overlay of `displayId` → physical screen pixels. */
export function localToPhysical(x: number, y: number, maps: readonly DisplayMap[], displayId: number): { x: number; y: number } | null {
  const d = maps.find((m) => m.id === displayId);
  return d ? { x: d.phys.x + x * d.scale, y: d.phys.y + y * d.scale } : null;
}
