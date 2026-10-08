import type { Strings } from '../../shared/i18n';
import type { UpdateState } from '../../shared/update';

/** The small note beside the version: when the last check was and what it found. Nothing before the first check finishes. */
export function checkNote(s: UpdateState, t: Strings, formatTime: (ms: number) => string): string | null {
  if (s.phase !== 'idle' || s.lastCheck === null) return null;
  return `${t.upToDate} · ${t.checkedAt(formatTime(s.lastCheck))}`;
}

/** The time of a check as the user's clock shows it, in the page's language: "14:32" or "2:32 PM". */
export const formatCheckTime = (ms: number, lang: string): string =>
  new Date(ms).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });
