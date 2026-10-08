import type { Strings } from './i18n';

/** Where the update checker is. Replaced on every change, never mutated. */
export type UpdateState =
  | { phase: 'idle'; lastCheck: number | null }
  | { phase: 'checking'; manual: boolean }
  | { phase: 'available'; version: string; notesUrl: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; message: string; retry: 'check' | 'download' };

/** Numeric x.y.z, each part up to nine digits (so every part is an exact number). No prefix, no suffix, no spaces. */
const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

export const isVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v);

/** Whether `candidate` is a higher version than `current`. Numeric x.y.z only: anything else, in either argument, is false. */
export function isNewer(candidate: string, current: string): boolean {
  const a = typeof candidate === 'string' ? VERSION.exec(candidate) : null;
  const b = typeof current === 'string' ? VERSION.exec(current) : null;
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

/** The most characters of an error's reason that the update card shows. */
export const REASON_MAX_CHARS = 150;

/**
 * The part of an error message that is fit to show: the first line that has text, trimmed, and at most REASON_MAX_CHARS characters
 * (ending in an ellipsis when it was cut). electron-updater's messages carry a stack, a headers dump or a whole HTML page after the
 * first line; the full text stays in the log. An empty or blank message gives ''.
 */
export function shortReason(reason: string): string {
  const line = reason.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  const chars = Array.from(line); // by character, so a pair of UTF-16 units is never cut in half
  if (chars.length <= REASON_MAX_CHARS) return line;
  return `${chars.slice(0, REASON_MAX_CHARS - 1).join('').trimEnd()}…`;
}

/** The message of an update error card, from the kind of failure and the raw reason. */
export function updateErrorText(t: Strings, kind: 'check' | 'download' | 'damaged' | 'install', reason: string): string {
  const short = shortReason(reason);
  if (kind === 'check') return t.updateErrCheck(short || t.updateReasonUnknown);
  if (kind === 'download') return short ? `${t.updateErrDownload} (${short})` : t.updateErrDownload;
  return kind === 'damaged' ? t.updateErrDamaged : t.updateErrInstall;
}
