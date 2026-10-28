import { formatRoomCode, parseRoomCode } from './roomCode';

export const SAVED_ROOMS_MAX = 20;
export const ROOM_LABEL_MAX = 32;
export interface SavedRoom { code: string; label: string; joinedAt: number }
export type SavedRoomEdit = { action: 'rename'; code: string; label: string } | { action: 'forget'; code: string };

export function roomLabel(value: string): string {
  return Array.from(value.slice(0, 256).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .slice(0, ROOM_LABEL_MAX).join('');
}

function canonicalCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const text = value.trim();
  const parsed = parseRoomCode(text.length === 10 ? formatRoomCode(text) : text, { strict: true });
  return parsed.ok ? parsed.code : null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Old settings migrate the last room once; an explicit empty list stays empty. */
export function normalizeSavedRooms(raw: unknown, legacyCode?: unknown): SavedRoom[] {
  if (!Array.isArray(raw)) {
    const code = canonicalCode(legacyCode);
    return code ? [{ code, label: '', joinedAt: 0 }] : [];
  }
  const rows: SavedRoom[] = [];
  for (const value of raw.slice(0, 200)) {
    if (!record(value)) continue;
    const code = canonicalCode(value.code);
    if (!code) continue;
    rows.push({ code, label: typeof value.label === 'string' ? roomLabel(value.label) : '',
      joinedAt: typeof value.joinedAt === 'number' && Number.isSafeInteger(value.joinedAt) && value.joinedAt > 0
        && value.joinedAt <= 8_640_000_000_000_000 ? value.joinedAt : 0 });
  }
  rows.sort((a, b) => b.joinedAt - a.joinedAt);
  const seen = new Set<string>(), distinct: SavedRoom[] = [];
  for (const row of rows) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    distinct.push(row);
    if (distinct.length === SAVED_ROOMS_MAX) break;
  }
  return distinct;
}

/** Called only after a room has settled successfully, including tray joins and startup rejoin. */
export function rememberSavedRoom(current: readonly SavedRoom[], code: string, now: number): SavedRoom[] {
  const parsed = canonicalCode(code);
  if (!parsed) return normalizeSavedRooms(current);
  const old = current.find((row) => row.code === parsed);
  return normalizeSavedRooms([{ code: parsed, label: old?.label ?? '', joinedAt: now },
    ...current.filter((row) => row.code !== parsed)]);
}

/** A narrow edit cannot add an unjoined room or overwrite a concurrently updated list. */
export function editSavedRooms(current: readonly SavedRoom[], raw: unknown): SavedRoom[] | null {
  if (!record(raw)) return null;
  const code = canonicalCode(raw.code);
  if (!code || !current.some((row) => row.code === code)) return null;
  if (raw.action === 'forget') return current.filter((row) => row.code !== code);
  if (raw.action !== 'rename' || typeof raw.label !== 'string') return null;
  const label = roomLabel(raw.label);
  return current.map((row) => row.code === code ? { ...row, label } : row);
}
