import { describe, expect, it } from 'vitest';
import { linuxX11RelaunchArgs } from '../../src/main/linuxX11Args';

describe('linuxX11RelaunchArgs', () => {
  it('prepends the X11 Ozone and scale flags when WAYLAND_DISPLAY is set and argv lacks an Ozone flag', () => {
    expect(linuxX11RelaunchArgs(['/opt/lolPing/lolping', '--hidden'], { WAYLAND_DISPLAY: 'wayland-0' })).toEqual([
      '--ozone-platform=x11',
      '--force-device-scale-factor=1',
      '--hidden',
    ]);
  });

  it('returns null when WAYLAND_DISPLAY is unset or empty', () => {
    expect(linuxX11RelaunchArgs(['/opt/lolPing/lolping'], {})).toBeNull();
    expect(linuxX11RelaunchArgs(['/opt/lolPing/lolping'], { WAYLAND_DISPLAY: '' })).toBeNull();
  });

  it('returns null when an Ozone platform flag is already on argv', () => {
    expect(
      linuxX11RelaunchArgs(['/opt/lolPing/lolping', '--ozone-platform=x11'], { WAYLAND_DISPLAY: 'wayland-0' }),
    ).toBeNull();
    expect(
      linuxX11RelaunchArgs(['/opt/lolPing/lolping', '--ozone-platform', 'x11'], { WAYLAND_DISPLAY: 'wayland-0' }),
    ).toBeNull();
  });

  it('returns null when running as Node for the MCP bridge', () => {
    expect(
      linuxX11RelaunchArgs(['/opt/lolPing/lolping', 'bridge.js'], {
        WAYLAND_DISPLAY: 'wayland-0',
        ELECTRON_RUN_AS_NODE: '1',
      }),
    ).toBeNull();
  });
});
