import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LINUX_X11_SWITCHES } from './linuxX11Args';

/** Desktop Entry Exec quoting has two escape layers: string values, then command arguments. */
export function linuxDesktopEntry(executable: string): string {
  if (/[\r\n\0]/.test(executable)) throw new Error('Invalid executable path');
  const quoted = executable.replace(/[%]/g, '%%').replace(/[\\"`$]/g, '\\$&').replace(/\\/g, '\\\\');
  return `[Desktop Entry]\nType=Application\nName=lolPing\nComment=Desktop ping wheel\nExec="${quoted}" ${LINUX_X11_SWITCHES.join(' ')} --hidden\nTerminal=false\nStartupNotify=false\nX-GNOME-Autostart-enabled=true\n`;
}

export function setLinuxAutostart(
  enabled: boolean,
  executable = process.env.APPIMAGE || process.execPath,
  configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
): void {
  const dir = join(configHome, 'autostart');
  const path = join(dir, 'lolPing.desktop');
  if (!enabled) { rmSync(path, { force: true }); return; }
  const content = linuxDesktopEntry(executable);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, { mode: 0o644 });
}
