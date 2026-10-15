import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmoteLibrary } from '../../src/main/emoteLibrary';
import { registerSettingsIpc, type SettingsIpcDeps } from '../../src/main/settingsIpc';
import { SettingsStore } from '../../src/main/settingsStore';
import { strings } from '../../src/shared/i18n';
import { SETTINGS_CH } from '../../src/shared/ipc';
import type { UpdateState } from '../../src/shared/update';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  opened: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  globalShortcut: { register: () => true, unregister: () => undefined },
  shell: { openExternal: async (url: string) => void h.opened.push(url) },
  net: {},
  protocol: {},
}));

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
/** A 160 × 160 lossy WebP header padded out; `fill` makes each one a different image. */
const still = (fill: number): Uint8Array => {
  const out = new Uint8Array(400).fill(fill);
  out.set([...ascii('RIFFxxxxWEBPVP8 '), 0, 0, 0, 0, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 160, 0, 160, 0]);
  return out;
};
const idOf = (b: Uint8Array): string => `c:${createHash('sha256').update(b).digest('hex').slice(0, 32)}`;

let store: SettingsStore;
let library: EmoteLibrary;
const call = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(h.handlers.get(channel)!({}, ...args));

beforeEach(() => {
  h.handlers.clear();
  h.opened.length = 0;
  const dir = mkdtempSync(join(tmpdir(), 'lolping-ipc-'));
  store = new SettingsStore(dir, 60_000);
  store.load();
  library = new EmoteLibrary(join(dir, 'emotes'));
  registerWith();
});

/** Registers the handlers again, with or without an update checker. */
function registerWith(update?: SettingsIpcDeps['update']): void {
  h.handlers.clear();
  registerSettingsIpc({
    store, library, text: () => strings('en'), platform: 'win', room: {}, update,
  } as unknown as SettingsIpcDeps);
}

describe('settings IPC', () => {
  it('setSettings ignores customEmotes from the window', async () => {
    const forged = [{ id: `c:${'ab'.repeat(16)}`, name: 'forged', animated: true }];
    const result = await call(SETTINGS_CH.set, { volume: 12, customEmotes: forged });
    expect(result).toMatchObject({ ok: true, settings: { volume: 12, customEmotes: [] } });
    expect(store.get().customEmotes).toEqual([]);
  });

  it('setSettings treats a patch that is not an object as no change', async () => {
    expect(await call(SETTINGS_CH.set, null)).toMatchObject({ ok: true, settings: { volume: store.get().volume } });
  });

  it('imports an emote: the files are saved and the entry is added', async () => {
    const s = still(1);
    expect(await call(SETTINGS_CH.emoteImport, { name: 'cat', still: s })).toEqual({ ok: true, id: idOf(s) });
    expect(store.get().customEmotes).toEqual([{ id: idOf(s), name: 'cat', animated: false }]);
    expect(existsSync(join(library.dir, `${idOf(s).slice(2)}.webp`))).toBe(true);
    expect(await call(SETTINGS_CH.emoteImport, { name: 'again', still: s })).toEqual({ ok: false, error: 'duplicate' });
    expect(store.get().customEmotes).toHaveLength(1);
  });

  it('refuses a payload that is not a name and bytes', async () => {
    for (const raw of [null, 'x', { name: 'x' }, { name: 1, still: still(1) }, { name: 'x', still: [1, 2, 3] }, { name: 'x', still: still(1), anim: {} }]) {
      expect(await call(SETTINGS_CH.emoteImport, raw)).toEqual({ ok: false, error: 'type' });
    }
    expect(store.get().customEmotes).toEqual([]);
    expect(existsSync(library.dir) ? readdirSync(library.dir) : []).toEqual([]);
  });

  it('imports several at once one after another, so the 25th is refused', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => call(SETTINGS_CH.emoteImport, { name: `e${i}`, still: still(i + 1) })));
    expect(results.filter((r) => (r as { ok: boolean }).ok)).toHaveLength(24);
    expect(results[24]).toEqual({ ok: false, error: 'full' });
    expect(store.get().customEmotes).toHaveLength(24);
    expect(readdirSync(library.dir)).toHaveLength(24);
  });

  it('removes an emote: its files and entry go, and the wheel slot falls back', async () => {
    const s = still(2);
    await call(SETTINGS_CH.emoteImport, { name: 'dog', still: s });
    const wheel = [idOf(s), ...store.get().emoteWheel.slice(1)];
    store.update({ emoteWheel: wheel, clickEmoteId: idOf(s) });
    expect(store.get().emoteWheel[0]).toBe(idOf(s));
    await call(SETTINGS_CH.emoteRemove, idOf(s));
    expect(store.get().customEmotes).toEqual([]);
    expect(store.get().emoteWheel[0]).not.toBe(idOf(s));
    expect(store.get().clickEmoteId).not.toBe(idOf(s));
    expect(readdirSync(library.dir)).toEqual([]);
  });

  it('ignores a removal that is not an imported emote id', async () => {
    const s = still(3);
    await call(SETTINGS_CH.emoteImport, { name: 'x', still: s });
    for (const raw of [null, 'facepalm', '../settings', { id: idOf(s) }]) await call(SETTINGS_CH.emoteRemove, raw);
    expect(store.get().customEmotes).toHaveLength(1);
  });
});

describe('update IPC', () => {
  const AVAILABLE: UpdateState = { phase: 'available', version: '0.5.1', notesUrl: 'https://github.com/darrenprx/lolPing/releases/tag/v0.5.1' };

  const NOTES = 'https://github.com/darrenprx/lolPing/releases/tag/v0.5.1';

  /** `notesUrl`: the release notes of the update the checker knows about, if it knows one. */
  function fakeUpdate(state: UpdateState, notesUrl: string | null = null) {
    return { state: vi.fn(() => state), notesUrl: vi.fn(() => notesUrl), check: vi.fn(async (): Promise<void> => undefined), start: vi.fn(async (): Promise<void> => undefined) };
  }

  it('without an update checker, getUpdate says null and the others do nothing', async () => {
    expect(await call(SETTINGS_CH.updateGet)).toBeNull();
    await call(SETTINGS_CH.updateCheck);
    await call(SETTINGS_CH.updateStart);
    await call(SETTINGS_CH.updateOpenRelease);
    expect(h.opened).toEqual([]);
  });

  it('getUpdate returns the state of the update checker', async () => {
    registerWith(fakeUpdate(AVAILABLE));
    expect(await call(SETTINGS_CH.updateGet)).toEqual(AVAILABLE);
  });

  it('checkForUpdates runs a check and waits for it', async () => {
    const u = fakeUpdate(AVAILABLE);
    let finish!: () => void;
    u.check.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    registerWith(u);
    let done = false;
    const p = call(SETTINGS_CH.updateCheck).then(() => (done = true));
    await Promise.resolve();
    expect(u.check).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    finish();
    await p;
    expect(done).toBe(true);
  });

  it('startUpdate starts the update and returns at once', async () => {
    const u = fakeUpdate(AVAILABLE);
    u.start.mockImplementation(() => new Promise<void>(() => undefined)); // an update takes minutes
    registerWith(u);
    await call(SETTINGS_CH.updateStart);
    expect(u.start).toHaveBeenCalledTimes(1);
  });

  it('startUpdate does not leave a rejection unhandled', async () => {
    const u = fakeUpdate(AVAILABLE);
    u.start.mockRejectedValue(new Error('boom'));
    registerWith(u);
    await expect(call(SETTINGS_CH.updateStart)).resolves.toBeUndefined();
  });

  it('openReleasePage opens the release notes of the version found', async () => {
    registerWith(fakeUpdate(AVAILABLE, NOTES));
    await call(SETTINGS_CH.updateOpenRelease);
    expect(h.opened).toEqual([NOTES]);
  });

  it('openReleasePage keeps opening the release notes after the download or the install failed', async () => {
    for (const state of [
      { phase: 'error', message: 'The download was damaged. Try again.', retry: 'download' },
      { phase: 'error', message: 'The update couldn’t be installed. Try again.', retry: 'download' },
      { phase: 'downloading', version: '0.5.1', percent: 3 },
      { phase: 'installing', version: '0.5.1' },
    ] as UpdateState[]) {
      h.opened.length = 0;
      registerWith(fakeUpdate(state, NOTES));
      await call(SETTINGS_CH.updateOpenRelease);
      expect(h.opened, state.phase).toEqual([NOTES]);
    }
  });

  it('openReleasePage opens the latest release when no version is known', async () => {
    for (const state of [
      { phase: 'idle', lastCheck: null },
      { phase: 'checking', manual: true },
      { phase: 'error', message: 'x', retry: 'check' },
    ] as UpdateState[]) {
      h.opened.length = 0;
      registerWith(fakeUpdate(state, null));
      await call(SETTINGS_CH.updateOpenRelease);
      expect(h.opened, state.phase).toEqual(['https://github.com/darrenprx/lolPing/releases/latest']);
    }
  });

  it('openReleasePage never opens a link that is not a web page', async () => {
    registerWith(fakeUpdate(AVAILABLE, 'file:///C:/Windows/System32/calc.exe'));
    await call(SETTINGS_CH.updateOpenRelease);
    expect(h.opened).toEqual(['https://github.com/darrenprx/lolPing/releases/latest']);
  });
});
