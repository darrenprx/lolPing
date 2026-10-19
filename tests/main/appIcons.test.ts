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

  it('reads the reference once and hides icons that only copy it', async () => {
    const reads: string[] = [];
    const icons = new AppIcons(async (path) => {
      reads.push(path);
      return path === 'ref.exe' || path === 'zcode.exe' ? 'default' : 'own';
    }, 'ref.exe');
    expect(await icons.icon('zcode.exe')).toBeNull();  // the default in disguise
    expect(await icons.icon('own.exe')).toBe('own');
    expect(reads.filter((p) => p === 'ref.exe')).toHaveLength(1);
  });

  it('shows everything when there is no reference file', async () => {
    const icons = new AppIcons(async (path) => (path === 'C:\\b.exe' ? null : 'own'));
    expect(await icons.icon('C:\\a.exe')).toBe('own');
    expect(await icons.icon('C:\\b.exe')).toBeNull();
    expect(await icons.icon('')).toBeNull();
  });
});
