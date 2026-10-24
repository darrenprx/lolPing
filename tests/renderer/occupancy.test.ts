import { describe, expect, it, vi } from 'vitest';
import { Occupancy } from '../../src/renderer/overlay/occupancy';

describe('Occupancy', () => {
  it('reports each occupied→empty and empty→occupied change exactly once', () => {
    let things = 0;
    const report = vi.fn();
    const o = new Occupancy(() => things > 0, report);
    o.refresh();
    expect(report).not.toHaveBeenCalled(); // starts empty, nothing changed
    things = 1;
    o.refresh();
    o.refresh();
    expect(report).toHaveBeenCalledExactlyOnceWith(true);
    things = 0;
    o.refresh();
    o.refresh();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(false);
  });

  it('follows the measure back and forth across many changes', () => {
    let empty = true;
    const states: boolean[] = [];
    const o = new Occupancy(() => !empty, (on) => states.push(on));
    for (let i = 0; i < 3; i++) {
      empty = false;
      o.refresh();
      empty = true;
      o.refresh();
    }
    expect(states).toEqual([true, false, true, false, true, false]);
  });
});
