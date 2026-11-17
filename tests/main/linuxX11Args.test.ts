import { describe, expect, it } from 'vitest';
import { linuxX11Relaunch } from '../../src/main/linuxX11Args';

const EXE = '/opt/lolPing/lolping';
const WL = { WAYLAND_DISPLAY: 'wayland-0' };

describe('linuxX11Relaunch', () => {
  it('prepends the X11 Ozone and scale flags when WAYLAND_DISPLAY is set and argv lacks an Ozone flag', () => {
    expect(linuxX11Relaunch([EXE, '--hidden'], WL, EXE)).toEqual({
      execPath: EXE,
      args: ['--ozone-platform=x11', '--force-device-scale-factor=1', '--hidden'],
    });
  });

  it('returns null when WAYLAND_DISPLAY is unset or empty', () => {
    expect(linuxX11Relaunch([EXE], {}, EXE)).toBeNull();
    expect(linuxX11Relaunch([EXE], { WAYLAND_DISPLAY: '' }, EXE)).toBeNull();
  });

  it('returns null when the process already runs with the X11 Ozone flag', () => {
    expect(linuxX11Relaunch([EXE, '--ozone-platform=x11', '--force-device-scale-factor=1'], WL, EXE)).toBeNull();
  });

  it('replaces a wayland or auto Ozone flag instead of keeping two', () => {
    for (const p of ['wayland', 'auto']) {
      expect(linuxX11Relaunch([EXE, `--ozone-platform=${p}`, '--hidden'], WL, EXE)?.args).toEqual([
        '--ozone-platform=x11', '--force-device-scale-factor=1', '--hidden',
      ]);
    }
  });

  it('drops the split form and its value, which Chromium would not read as a switch', () => {
    expect(linuxX11Relaunch([EXE, '--ozone-platform', 'x11', '--hidden'], WL, EXE)?.args).toEqual([
      '--ozone-platform=x11', '--force-device-scale-factor=1', '--hidden',
    ]);
  });

  it('relaunches the AppImage file, not the binary inside its temporary mount', () => {
    const r = linuxX11Relaunch(['/tmp/.mount_lolPiX/lolping'], { ...WL, APPIMAGE: '/home/p/lolPing.AppImage' },
      '/tmp/.mount_lolPiX/lolping');
    expect(r?.execPath).toBe('/home/p/lolPing.AppImage');
  });

  it('returns null when running as Node for the MCP bridge', () => {
    expect(linuxX11Relaunch([EXE, 'bridge.js'], { ...WL, ELECTRON_RUN_AS_NODE: '1' }, EXE)).toBeNull();
  });
});
