import { describe, expect, it } from 'vitest';
import { AppIcons } from '../../src/main/appIcons';

describe('AppIcons', () => {
  it('fetches one icon per path and serves the rest from the cache', async () => {
    let reads = 0;
    const icons = new AppIcons(async (path) => {
      ++reads;
      return `icon:${path}`;
    });
    expect(await icons.icon('C:\\a.exe')).toBe('icon:C:\\a.exe');
    expect(await icons.icon('C:\\a.exe')).toBe('icon:C:\\a.exe');
    expect(await icons.icon('C:\\b.exe')).toBe('icon:C:\\b.exe');
    expect(reads).toBe(2);
  });

  it('shares the flight, and a failed read settles null and stays cached', async () => {
    let reads = 0;
    const icons = new AppIcons(async () => {
      ++reads;
      throw new Error('no icon here');
    });
    const first = icons.icon('C:\\a.exe');
    const second = icons.icon('C:\\a.exe');
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(reads).toBe(1);
    expect(await icons.icon('')).toBeNull();
  });
});
