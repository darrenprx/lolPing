import { statSync } from 'node:fs';
import { dirname } from 'node:path';

const reported = new Set<string>();

/**
 * Whether `path` is a regular file. A file that isn't there (ENOENT, or ENOTDIR when a folder on the way is itself a file) is
 * a plain `false`. Any other error (EPERM, EACCES, a locked network share...) says nothing about the file: it is logged once
 * per folder and error, and the answer is `whenUnknown`, so the caller decides what a folder it can't read means. Never throws.
 */
export function isFile(path: string, whenUnknown: boolean): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    const key = `${code}:${dirname(path)}`;
    if (!reported.has(key)) {
      reported.add(key);
      console.warn('[emotes] cannot tell whether a file is there:', (err as Error).message);
    }
    return whenUnknown;
  }
}
