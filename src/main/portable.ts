import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A file next to the executable that makes an unpacked (zip) build keep its data beside itself. */
export const PORTABLE_MARKER = 'portable.txt';
/** The folder, next to the executable, that a portable build keeps its settings, emotes and cache in. */
export const PORTABLE_DATA_FOLDER = 'data';

/**
 * Where a portable build keeps its data, or null for an installed build.
 * electron-builder's portable launcher unpacks the app to a temp folder and sets PORTABLE_EXECUTABLE_DIR to the folder the
 * .exe was started from, so that is where the data goes. An unpacked build (a zip of the `dir` target, or a copied .app)
 * is portable when `portable.txt` sits next to its executable. A development build is never portable.
 */
export function portableDataDir(o: {
  env: NodeJS.ProcessEnv; execPath: string; packaged: boolean; exists?: (path: string) => boolean;
}): string | null {
  if (!o.packaged) return null;
  const exists = o.exists ?? existsSync;
  const launcherDir = o.env.PORTABLE_EXECUTABLE_DIR;
  if (launcherDir) return join(launcherDir, PORTABLE_DATA_FOLDER);
  const exeDir = dirname(o.execPath);
  if (exists(join(exeDir, PORTABLE_MARKER))) return join(exeDir, PORTABLE_DATA_FOLDER);
  return null;
}
