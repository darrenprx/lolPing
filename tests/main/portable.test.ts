import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { portableDataDir } from '../../src/main/portable';

const exe = join('C:', 'Apps', 'lolPing', 'lolPing.exe');
const never = () => false;

describe('portable build detection', () => {
  it('uses the launcher folder electron-builder\'s portable .exe reports', () => {
    const dir = portableDataDir({ env: { PORTABLE_EXECUTABLE_DIR: join('E:', 'tools') }, execPath: exe, packaged: true, platform: 'win', exists: never });
    expect(dir).toBe(join('E:', 'tools', 'data'));
  });
  it('is portable when portable.txt sits next to the executable of an unpacked build', () => {
    const marker = join('C:', 'Apps', 'lolPing', 'portable.txt');
    const dir = portableDataDir({ env: {}, execPath: exe, packaged: true, platform: 'win', exists: (p) => p === marker });
    expect(dir).toBe(join('C:', 'Apps', 'lolPing', 'data'));
  });
  it('is an installed build otherwise', () => {
    expect(portableDataDir({ env: {}, execPath: exe, packaged: true, platform: 'win', exists: never })).toBeNull();
  });
  it('is never portable on macOS or Linux, even with a marker or the launcher variable', () => {
    for (const platform of ['mac', 'linux'] as const) {
      expect(portableDataDir({ env: { PORTABLE_EXECUTABLE_DIR: 'x' }, execPath: exe, packaged: true, platform, exists: () => true }))
        .toBeNull();
    }
  });
  it('never treats a development build as portable, even with a marker or the launcher variable', () => {
    expect(portableDataDir({ env: { PORTABLE_EXECUTABLE_DIR: 'x' }, execPath: exe, packaged: false, platform: 'win', exists: () => true })).toBeNull();
  });
});
