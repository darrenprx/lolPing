import { rememberSavedRoom } from '../shared/savedRooms';
import type { RoomManager } from './roomManager';
import type { SettingsStore } from './settingsStore';

/** Preserve room history on leave, and record only successful joins from every entry point. */
export function rememberRoomJoins(room: RoomManager, store: SettingsStore, now: () => number): () => void {
  const save = (code: string | null): void => {
    store.update({ lastRoomCode: code,
      ...(code ? { savedRooms: rememberSavedRoom(store.get().savedRooms, code, now()) } : {}) });
  };
  room.on('saveCode', save);
  return () => room.off('saveCode', save);
}
