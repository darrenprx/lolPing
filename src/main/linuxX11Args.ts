/**
 * Flags that keep Electron's main and GPU processes on X11 with 1:1 root-window coordinates on Linux.
 * In Electron 44+, Chromium chooses the Ozone platform in C++ before the main script runs: when `WAYLAND_DISPLAY` is
 * set and `--ozone-platform=x11` is not on the command line, the main process starts on Wayland while the GPU process
 * receives the switch from `app.commandLine.appendSwitch`, crashing the GPU process on Wayland surface IDs.
 */
export const LINUX_X11_SWITCHES: readonly string[] = ['--ozone-platform=x11', '--force-device-scale-factor=1'];

/**
 * The argument list to re-launch Electron with when a Linux start under Wayland missed `--ozone-platform=x11` on argv,
 * or null when the current process can proceed as-is.
 */
export function linuxX11RelaunchArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] | null {
  if (!env.WAYLAND_DISPLAY || env.ELECTRON_RUN_AS_NODE) return null;
  if (argv.some((a) => a === '--ozone-platform' || a.startsWith('--ozone-platform='))) return null;
  return [...LINUX_X11_SWITCHES, ...argv.slice(1)];
}
