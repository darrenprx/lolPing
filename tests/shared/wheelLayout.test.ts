import { describe, expect, it } from 'vitest';
import { DEFAULT_WHEEL, type PingId } from '../../src/shared/pings';
import { dropPatch, isValidWheel, placeOnSlot, swapSlots } from '../../src/shared/wheelLayout';

const W = [...DEFAULT_WHEEL];

describe('isValidWheel', () => {
  it('accepts the default layout', () => {
    expect(isValidWheel(W)).toBe(true);
  });

  it('accepts the new pings and the generic ping', () => {
    expect(isValidWheel(['bait', 'visioncleared', 'generic', 'allin', 'assist', 'needvision', 'missing', 'enemyvision'])).toBe(true);
  });

  it('rejects the wrong number of slots', () => {
    expect(isValidWheel(W.slice(0, 7))).toBe(false);
    expect(isValidWheel([...W, 'bait'])).toBe(false);
  });

  it('rejects unknown ids, duplicates and non-arrays', () => {
    expect(isValidWheel(['nope', ...W.slice(1)])).toBe(false);
    expect(isValidWheel(['push', ...W.slice(1)])).toBe(false);
    expect(isValidWheel('danger')).toBe(false);
    expect(isValidWheel(undefined)).toBe(false);
  });
});

describe('placeOnSlot', () => {
  it('puts a ping that is not on the wheel into the slot', () => {
    const next = placeOnSlot(W, 'bait', 2);
    expect(next[2]).toBe('bait');
    expect(next.filter((id) => id === 'omw')).toEqual([]);
  });

  it('swaps when the ping is already on the wheel', () => {
    const next = placeOnSlot(W, 'danger', 5);
    expect(next[5]).toBe('danger');
    expect(next[0]).toBe('needvision');
  });

  it('is a no-op for the slot the ping is already in', () => {
    expect(placeOnSlot(W, 'push', 1)).toEqual(W);
  });

  it('does not mutate its input', () => {
    const before = [...W];
    placeOnSlot(W, 'bait', 0);
    expect(W).toEqual(before);
  });

  it('always yields a valid wheel', () => {
    let wheel: PingId[] = W;
    const ids: PingId[] = ['bait', 'visioncleared', 'generic', 'danger', 'omw', 'bait'];
    ids.forEach((id, n) => {
      wheel = placeOnSlot(wheel, id, (n * 3) % 8);
      expect(isValidWheel(wheel)).toBe(true);
    });
  });
});

describe('swapSlots', () => {
  it('swaps two slots', () => {
    const next = swapSlots(W, 0, 1);
    expect(next.slice(0, 2)).toEqual(['push', 'danger']);
    expect(next.slice(2)).toEqual(W.slice(2));
  });

  it('does not mutate its input', () => {
    const before = [...W];
    swapSlots(W, 3, 7);
    expect(W).toEqual(before);
  });
});

describe('dropPatch', () => {
  it('assigns a pool ping to a slot', () => {
    expect(dropPatch(W, 'generic', { from: 'pool', id: 'bait' }, 2)).toEqual({ wheel: placeOnSlot(W, 'bait', 2) });
  });

  it('swaps when a slot is dropped on another slot', () => {
    expect(dropPatch(W, 'generic', { from: 'slot', id: 'danger', slot: 0 }, 4)).toEqual({ wheel: swapSlots(W, 0, 4) });
  });

  it('sets the centre from the pool or a slot, leaving the wheel alone', () => {
    expect(dropPatch(W, 'generic', { from: 'pool', id: 'visioncleared' }, 'center')).toEqual({ center: 'visioncleared' });
    expect(dropPatch(W, 'generic', { from: 'slot', id: 'push', slot: 1 }, 'center')).toEqual({ center: 'push' });
  });

  it('puts the centre on the wheel when it is dropped on a slot', () => {
    expect(dropPatch(W, 'bait', { from: 'center', id: 'bait' }, 3)).toEqual({ wheel: placeOnSlot(W, 'bait', 3) });
  });

  it('returns null when nothing would change', () => {
    expect(dropPatch(W, 'generic', { from: 'slot', id: 'omw', slot: 2 }, 2)).toBeNull();
    expect(dropPatch(W, 'generic', { from: 'pool', id: 'omw' }, 2)).toBeNull();
    expect(dropPatch(W, 'generic', { from: 'pool', id: 'generic' }, 'center')).toBeNull();
    expect(dropPatch(W, 'generic', { from: 'center', id: 'generic' }, 'center')).toBeNull();
  });
});

describe('works for string refs', () => {
  const E = ['unworthy_cn', 'poro_snax', 'sad_kitten', 'cheeky_poro', 'angry_kitty', 'gg_heart', 'bee_happy', 'bee_mad'];
  const custom = 'c:0123456789abcdef0123456789abcdef';

  it('assigns a pool emote to a slot, swapping when it is already on the wheel', () => {
    expect(dropPatch(E, 'facepalm', { from: 'pool', id: 'nice' }, 2)).toEqual({ wheel: placeOnSlot(E, 'nice', 2) });
    expect(placeOnSlot(E, 'nice', 2)[2]).toBe('nice');
    const swapped = dropPatch(E, 'facepalm', { from: 'pool', id: 'bee_mad' }, 0);
    expect(swapped?.wheel?.[0]).toBe('bee_mad');
    expect(swapped?.wheel?.[7]).toBe('unworthy_cn');
    expect(dropPatch(E, 'facepalm', { from: 'pool', id: custom }, 5)?.wheel?.[5]).toBe(custom);
  });

  it('swaps slot with slot', () => {
    expect(dropPatch(E, 'facepalm', { from: 'slot', id: 'poro_snax', slot: 1 }, 6)).toEqual({ wheel: swapSlots(E, 1, 6) });
    expect(swapSlots(E, 1, 6)[6]).toBe('poro_snax');
  });

  it('sets the centre from the pool', () => {
    expect(dropPatch(E, 'facepalm', { from: 'pool', id: 'nice' }, 'center')).toEqual({ center: 'nice' });
    expect(dropPatch(E, 'facepalm', { from: 'pool', id: custom }, 'center')).toEqual({ center: custom });
    expect(dropPatch(E, 'facepalm', { from: 'pool', id: 'facepalm' }, 'center')).toBeNull();
  });
});
