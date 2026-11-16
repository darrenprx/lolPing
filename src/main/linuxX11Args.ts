/**
 * Flags that keep Electron's main and GPU processes on X11 with 1:1 root-window coordinates on Linux.
 * In Electron 44+, Chromium chooses the Ozone platform in C++ before the main script runs: when `WAYLAND_DISPLAY` is
 * set and `--ozone-platform=x11` is not on the command line, the main process starts on Wayland while the GPU process
 * receives the switch from `app.commandLine.appendSwitch`, crashing the GPU process on Wayland surface IDs.
 */
export const LINUX_X11_SWITCHES: readonly string[] = ['--ozone-platform=x11', '--force-device-scale-factor=1'];

const OZONE = '--ozone-platform';
const SCALE = '--force-device-scale-factor';

/** The relaunch for a Linux start under Wayland that is not already on X11, or null to go on as-is. */
export interface X11Relaunch {
  /** The AppImage file when run from one: its mount goes away when this process exits. */
  execPath: string;
  args: string[];
}

/**
 * Any other Ozone choice (`wayland`, `auto`, or the split form Chromium ignores) is replaced with ours, so the
 * relaunched process never sees two.
 */
export function linuxX11Relaunch(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): X11Relaunch | null {
  if (!env.WAYLAND_DISPLAY || env.ELECTRON_RUN_AS_NODE) return null;
  if (argv.includes(`${OZONE}=x11`)) return null;
  const rest: string[] = [];
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === OZONE || a === SCALE) { i++; continue; }
    if (a.startsWith(`${OZONE}=`) || a.startsWith(`${SCALE}=`)) continue;
    rest.push(a);
  }
  return { execPath: env.APPIMAGE || execPath, args: [...LINUX_X11_SWITCHES, ...rest] };
}
