import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linuxDesktopEntry, setLinuxAutostart } from '../../src/main/linuxAutostart';

describe('Linux autostart', () => {
  it('creates and removes only the lolPing entry in XDG config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lolping-autostart-'));
    try {
      setLinuxAutostart(true, '/home/player/My Apps/lolPing.AppImage', dir);
      const file = join(dir, 'autostart/lolPing.desktop');
      expect(readFileSync(file, 'utf8')).toContain(
        'Exec="/home/player/My Apps/lolPing.AppImage" --ozone-platform=x11 --force-device-scale-factor=1 --hidden');
      setLinuxAutostart(false, '', dir);
      expect(existsSync(file)).toBe(false);
      setLinuxAutostart(false, '', dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('escapes desktop field codes and rejects injected desktop lines', () => {
    expect(linuxDesktopEntry('/tmp/%F.AppImage')).toContain('/tmp/%%F.AppImage');
    expect(() => linuxDesktopEntry('/tmp/app\nHidden=true')).toThrow('Invalid executable path');
    expect(() => linuxDesktopEntry('/tmp/app\0')).toThrow('Invalid executable path');
  });
});
