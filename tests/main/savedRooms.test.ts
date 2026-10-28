import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../../src/main/roomManager';
import { rememberRoomJoins } from '../../src/main/savedRooms';
import { SettingsStore } from '../../src/main/settingsStore';
import { makeRoomCode } from '../../src/shared/roomCode';
import { FakeTransport } from './fixtures/fakeTransport';

const roots: string[] = [], rooms: RoomManager[] = [], stores: SettingsStore[] = [];
function fixture() {
  vi.useFakeTimers({ now: 1_790_000_000_000 });
  const dir = mkdtempSync(join(tmpdir(), 'lolping-savedrooms-'));
  roots.push(dir);
  const store = new SettingsStore(dir, 60_000);
  stores.push(store);
  store.load();
  let seed = 1, fail = false;
  const room = new RoomManager({ transports: [new FakeTransport('lan')], now: Date.now,
    randomBytes: (n) => new Uint8Array(n).fill(seed++),
    deriveKeys: async () => { if (fail) throw new Error('synthetic failure'); return { msgKey: Buffer.alloc(32, 1), relayTopic: 'fixture' }; },
    appVersion: '0.6.0', profile: () => ({ name: 'Fixture', color: 1, rgb: null, limit: 5, nf: [] }),
    resolveTarget: () => null, announceEmotes: () => [] });
  rooms.push(room);
  rememberRoomJoins(room, store, Date.now);
  return { room, store, dir, fail: () => { fail = true; } };
}
afterEach(async () => {
  for (const room of rooms.splice(0)) room.quit();
  for (const store of stores.splice(0)) await store.flush();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('rememberRoomJoins', () => {
  it('records successful creation and switches, persists names, and retains history on leave', async () => {
    const { room, store, dir } = fixture();
    await room.create();
    expect(store.get().savedRooms).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    const first = store.get().savedRooms[0].code;
    store.update({ savedRooms: [{ ...store.get().savedRooms[0], label: '午间组' }] });
    const other = makeRoomCode(new Uint8Array(9).fill(7));
    await room.join(other);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.get().savedRooms.map((r) => r.code)).toEqual([other, first]);
    room.leave();
    expect(store.get().lastRoomCode).toBeNull();
    expect(store.get().savedRooms).toHaveLength(2);
    await store.flush();
    const reloaded = new SettingsStore(dir);
    expect(reloaded.load().savedRooms[1].label).toBe('午间组');
  });
  it('does not save a failed or interrupted join', async () => {
    const f = fixture();
    await f.room.create();
    f.room.leave();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.get().savedRooms).toEqual([]);
    f.fail();
    expect(await f.room.join(makeRoomCode(new Uint8Array(9).fill(4)))).toEqual({ ok: false, error: 'failed' });
    expect(f.store.get().savedRooms).toEqual([]);
  });
});
