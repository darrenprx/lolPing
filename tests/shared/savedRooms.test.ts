import { describe, expect, it } from 'vitest';
import { formatRoomCode, makeRoomCode } from '../../src/shared/roomCode';
import { editSavedRooms, normalizeSavedRooms, rememberSavedRoom, roomLabel, SAVED_ROOMS_MAX } from '../../src/shared/savedRooms';
import { normalizeSettings, rendererPatch } from '../../src/shared/settings';

const code = (n: number): string => makeRoomCode(new Uint8Array(9).fill(n));

describe('savedRooms', () => {
  it('migrates an old last room only when no list is present', () => {
    expect(normalizeSettings({ lastRoomCode: code(1) }).savedRooms).toEqual([{ code: code(1), label: '', joinedAt: 0 }]);
    expect(normalizeSettings({ lastRoomCode: code(1), savedRooms: [] }).savedRooms).toEqual([]);
    expect(normalizeSettings({ lastRoomCode: 'broken' }).savedRooms).toEqual([]);
  });
  it('validates codes, deduplicates canonical forms and keeps the newest record', () => {
    expect(normalizeSavedRooms([{ code: code(1), label: 'old', joinedAt: 2 },
      { code: formatRoomCode(code(1)), label: 'new', joinedAt: 3 }, null, 'wrong', { code: 'wrong' },
      { code: code(2), joinedAt: Infinity }])).toEqual([
      { code: code(1), label: 'new', joinedAt: 3 }, { code: code(2), label: '', joinedAt: 0 },
    ]);
  });
  it('bounds the history and evicts the least recent room', () => {
    const rows = normalizeSavedRooms(Array.from({ length: 25 }, (_, n) => ({ code: code(n), joinedAt: n + 1 })));
    expect(rows).toHaveLength(SAVED_ROOMS_MAX);
    expect(rows[0].code).toBe(code(24));
    expect(rows.at(-1)?.code).toBe(code(5));
  });
  it('keeps valid all-letter canonical codes during migration', () => {
    const letters = code(10);
    expect(normalizeSettings({ lastRoomCode: letters }).lastRoomCode).toBe(letters);
    expect(normalizeSettings({ lastRoomCode: letters }).savedRooms[0].code).toBe(letters);
  });
  it('moves a rejoined room to the top while preserving its name', () => {
    const rows = normalizeSavedRooms([{ code: code(1), label: '研发 午间组', joinedAt: 1 }, { code: code(2), joinedAt: 2 }]);
    const next = rememberSavedRoom(rows, code(1), 3);
    expect(next).toEqual([{ code: code(1), label: '研发 午间组', joinedAt: 3 }, { code: code(2), label: '', joinedAt: 2 }]);
    expect(rows[0].code).toBe(code(2));
  });
  it('renames and removes exactly one room without changing the remaining records', () => {
    const rows = rememberSavedRoom(rememberSavedRoom([], code(1), 1), code(2), 2);
    const renamed = editSavedRooms(rows, { action: 'rename', code: code(1), label: ' 朋友组\n' });
    expect(renamed?.[1].label).toBe('朋友组');
    expect(editSavedRooms(rows, { action: 'forget', code: code(1) })).toEqual([rows[0]]);
    expect(rows).toHaveLength(2);
  });
  it.each([null, {}, { action: 'rename', code: code(1), label: 2 }, { action: 'forget', code: code(2) },
    { action: 'overwrite', code: code(1) }])('rejects malformed or unknown edits: %j', (edit) => {
    expect(editSavedRooms(rememberSavedRoom([], code(1), 1), edit)).toBeNull();
  });
  it('bounds labels by Unicode characters and strips control characters', () => {
    expect(roomLabel('  研发 午间组\n\u0000 ')).toBe('研发 午间组');
    expect(Array.from(roomLabel('😀'.repeat(80)))).toHaveLength(32);
  });
  it('does not let a stale settings patch replace room history', () => {
    expect(rendererPatch({ savedRooms: [], volume: 0.5 })).toEqual({ volume: 0.5 });
  });
});
