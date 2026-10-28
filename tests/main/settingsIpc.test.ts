import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmoteLibrary } from '../../src/main/emoteLibrary';
import { registerSettingsIpc, type SettingsIpcDeps } from '../../src/main/settingsIpc';
import { SettingsStore } from '../../src/main/settingsStore';
import { SecretStore, type Crypto } from '../../src/main/teammate/secrets';
import { ProviderError } from '../../src/main/teammate/providers/types';
import { strings } from '../../src/shared/i18n';
import { SETTINGS_CH } from '../../src/shared/ipc';
import { MOD } from '../../src/shared/keys';
import type { AgentProfile, BuiltinProfile } from '../../src/shared/teammate/settings';
import type { UpdateState } from '../../src/shared/update';
import { makeRoomCode } from '../../src/shared/roomCode';

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
  it('edits one saved room and preserves newer records and the current room', async () => {
    const first = makeRoomCode(new Uint8Array(9).fill(1)), newer = makeRoomCode(new Uint8Array(9).fill(2));
    store.update({ lastRoomCode: first, savedRooms: [{ code: newer, label: '', joinedAt: 2 },
      { code: first, label: '', joinedAt: 1 }] });
    expect(await call(SETTINGS_CH.roomSavedEdit, { action: 'rename', code: first, label: ' 午间组 ' })).toBe(true);
    expect(store.get().savedRooms[1].label).toBe('午间组');
    expect(store.get().savedRooms[0].code).toBe(newer);
    expect(await call(SETTINGS_CH.roomSavedEdit, { action: 'forget', code: first })).toBe(true);
    expect(store.get().lastRoomCode).toBe(first);
    expect(store.get().savedRooms).toHaveLength(1);
  });
  it('rejects malformed list edits and ignores stale bulk list settings', async () => {
    const code = makeRoomCode(new Uint8Array(9).fill(1));
    store.update({ savedRooms: [{ code, label: 'keep', joinedAt: 1 }] });
    expect(await call(SETTINGS_CH.roomSavedEdit, { action: 'rename', code, label: null })).toBe(false);
    await call(SETTINGS_CH.set, { savedRooms: [] });
    expect(store.get().savedRooms[0].label).toBe('keep');
  });
  it('refuses to make the text and enable shortcuts identical', async () => {
    const result = await call(SETTINGS_CH.set, { textHotkey: store.get().toggleHotkey });
    expect(result).toMatchObject({ ok: false, error: strings('en').shortcutClash });
    expect(store.get().textHotkey).toEqual({ mods: MOD.alt, vk: 0x54 });
  });

  it('refuses a panel key that another shortcut uses', async () => {
    const result = await call(SETTINGS_CH.set, { panelKey: store.get().toggleHotkey.vk });
    expect(result).toMatchObject({ ok: false, error: strings('en').panelKeyClash });
    expect(store.get().panelKey).toBe(0x09);
  });

  it('refuses a custom emote key that is the panel key', async () => {
    expect(await call(SETTINGS_CH.set, { panelKey: 0x51 })).toMatchObject({ ok: true });
    expect(await call(SETTINGS_CH.set, { emoteTrigger: { vk: 0x51 } })).toMatchObject({ ok: false });
    expect(store.get().emoteTrigger).not.toEqual({ vk: 0x51 });
  });

  it('refuses a ping or emote key on the teammate ask key and says why', async () => {
    const s = store.get();
    store.update({ features: { ...s.features, teammate: true }, teammate: { ...s.teammate, askTrigger: 'mouse4' } });
    const reason = strings('en').teammate.settings.askKeyClash;
    expect(await call(SETTINGS_CH.set, { trigger: 'mouse4' })).toMatchObject({ ok: false, error: reason });
    expect(await call(SETTINGS_CH.set, { emoteTrigger: 'mouse4' })).toMatchObject({ ok: false, error: reason });
    expect(store.get().trigger).not.toBe('mouse4');
    expect(store.get().teammate.askTrigger).toBe('mouse4');
  });

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

  it('gives one of our emotes a sound and takes it away again', async () => {
    const s = still(4);
    const hash = idOf(s).slice(2);
    await call(SETTINGS_CH.emoteImport, { name: 'cow', still: s });
    const sound = new Uint8Array(300).fill(1);
    sound.set(ascii('OggS'));
    expect(await call(SETTINGS_CH.emoteSound, idOf(s), sound)).toEqual({ ok: true });
    expect(store.get().customEmotes).toEqual([{ id: idOf(s), name: 'cow', animated: false, sound: true }]);
    expect(readdirSync(library.dir).sort()).toEqual([`${hash}.sound.ogg`, `${hash}.webp`]);
    expect(await call(SETTINGS_CH.emoteSound, idOf(s), null)).toEqual({ ok: true });
    expect(store.get().customEmotes).toEqual([{ id: idOf(s), name: 'cow', animated: false }]);
    expect(readdirSync(library.dir)).toEqual([`${hash}.webp`]);
  });

  it('refuses a sound for an emote that is not ours, or that is not sound bytes', async () => {
    const s = still(5);
    await call(SETTINGS_CH.emoteImport, { name: 'x', still: s });
    const sound = new Uint8Array(ascii('OggS'));
    expect(await call(SETTINGS_CH.emoteSound, `c:${'ab'.repeat(16)}`, sound)).toEqual({ ok: false, error: 'type' });
    expect(await call(SETTINGS_CH.emoteSound, 'facepalm', sound)).toEqual({ ok: false, error: 'type' });
    expect(await call(SETTINGS_CH.emoteSound, idOf(s), [1, 2, 3])).toEqual({ ok: false, error: 'type' });
    expect(await call(SETTINGS_CH.emoteSound, idOf(s), new Uint8Array(300))).toEqual({ ok: false, error: 'type' });
    expect(store.get().customEmotes[0]).not.toHaveProperty('sound');
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

describe('teammate IPC', () => {
  const KEY = 'sk-secret-123456';
  const PROFILE: BuiltinProfile = {
    id: 'p1', kind: 'builtin', name: 'GPT', tagColor: 3, tagColorCustom: null, provider: 'openai', protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1', model: '',
  };
  /** A reversible stand-in for safeStorage. */
  const crypto: Crypto = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
  };

  let secrets: SecretStore | null;
  let listModels: (key: string) => Promise<string[]>;
  let historyOps: string[];
  let clearFails = false;
  let checked: string[];
  let picked: unknown;
  let bridgeUp = true;

  function registerTeammate(): void {
    h.handlers.clear();
    historyOps = [];
    checked = [];
    registerSettingsIpc({
      store, library, text: () => strings('en'), platform: 'win', room: {},
      teammate: {
        secrets: () => secrets,
        adapter: (_p: BuiltinProfile, key: string) => ({ listModels: () => listModels(key) }),
        usage: () => ({ month: '2026-10', input: 10, output: 2 }),
        checkAgent: async (p: AgentProfile) => {
          checked.push(p.command);
          return { ok: true, version: '1.0' };
        },
        pickFolder: async () => picked,
        agentSnippet: () => '{"mcpServers":{}}',
        bridge: () => (bridgeUp ? { command: 'lolPing.exe', args: ['bridge.js'], env: { LOLPING_PIPE: 'P' } } : null),
        recentApps: () => ['Code', 'chrome'],
        editors: async () => ['Code', 'idea64'],
        history: async (op: string) => {
          historyOps.push(op);
          return op !== 'clear' || !clearFails;
        },
      },
    } as unknown as SettingsIpcDeps);
  }

  beforeEach(() => {
    secrets = new SecretStore(join(mkdtempSync(join(tmpdir(), 'lolping-ipc-secrets-')), 'secrets'), crypto);
    listModels = async () => ['gpt-4o', 'gpt-4o-mini'];
    clearFails = false;
    store.update({
      features: { ...store.get().features, teammate: true }, teammate: { ...store.get().teammate, profiles: [PROFILE] },
    });
    registerTeammate();
  });

  it('never returns a key to the settings window', async () => {
    expect(await call(SETTINGS_CH.teammateSetKey, 'p1', KEY)).toEqual({ ok: true });
    expect(secrets?.key('p1')).toBe(KEY);
    const seen: unknown[] = [
      await call(SETTINGS_CH.teammateHasKey, 'p1'),
      await call(SETTINGS_CH.teammateCheckKey, 'p1'),
      await call(SETTINGS_CH.teammateInstructions),
      await call(SETTINGS_CH.teammateUsage),
      await call(SETTINGS_CH.get),
    ];
    expect(seen[0]).toBe(true);
    expect(seen[1]).toEqual({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] });
    // Some providers repeat the key they refused in their error message.
    listModels = async (key) => {
      throw new ProviderError('auth', `Incorrect API key provided: ${key}`, 401);
    };
    const refused = await call(SETTINGS_CH.teammateCheckKey, 'p1');
    expect(refused).toMatchObject({ ok: false, error: 'auth' });
    seen.push(refused);
    for (const result of seen) expect(JSON.stringify(result) ?? '').not.toContain(KEY);
  });

  it('checks an agent by the command saved in its profile, never one sent by the window', async () => {
    const agent: AgentProfile = {
      id: 'a1', kind: 'agent', name: 'Claude Code', tagColor: 3, tagColorCustom: null, preset: 'claude', command: 'claude',
      customArgs: [], folder: { kind: 'editor', folders: [] }, timeoutS: 300,
    };
    store.update({ teammate: { ...store.get().teammate, profiles: [PROFILE, agent] } });
    expect(await call(SETTINGS_CH.teammateCheckAgent, 'a1')).toEqual({ ok: true, version: '1.0' });
    expect(await call(SETTINGS_CH.teammateCheckAgent, { id: 'a1', command: 'calc' })).toMatchObject({ ok: false });
    expect(await call(SETTINGS_CH.teammateCheckAgent, 'p1')).toMatchObject({ ok: false }); // a provider profile
    expect(await call(SETTINGS_CH.teammateCheckAgent, 'nope')).toMatchObject({ ok: false });
    expect(checked).toEqual(['claude']);
  });

  it('gives the window only a plain folder path from the picker', async () => {
    picked = 'C:\\work\\app';
    expect(await call(SETTINGS_CH.teammatePickFolder)).toBe('C:\\work\\app');
    for (const bad of [null, '', 5, { path: 'x' }, 'x'.repeat(1025)]) {
      picked = bad;
      expect(await call(SETTINGS_CH.teammatePickFolder)).toBeNull();
    }
  });

  it('gives the window the snippet for an agent that reads its own MCP file, or its mcp add line', async () => {
    const agent = (id: string, preset: AgentProfile['preset']): AgentProfile => ({
      id, kind: 'agent', name: id, tagColor: 3, tagColorCustom: null, preset, command: id, customArgs: [],
      folder: { kind: 'editor', folders: [] }, timeoutS: 300,
    });
    const profiles = [PROFILE, agent('c', 'cursor'), agent('q', 'qoder')];
    store.update({ teammate: { ...store.get().teammate, profiles } });
    expect(await call(SETTINGS_CH.teammateAgentSnippet, 'c')).toEqual({ text: '{"mcpServers":{}}' });
    // Qoder has no MCP file to name, only its own command.
    expect(await call(SETTINGS_CH.teammateAgentSnippet, 'q')).toEqual({
      text: 'qodercli mcp add lolping -e LOLPING_PIPE=P -- lolPing.exe bridge.js',
    });
    for (const bad of ['p1', 'nope', 5, null]) expect(await call(SETTINGS_CH.teammateAgentSnippet, bad)).toBeNull();
    bridgeUp = false;
    expect(await call(SETTINGS_CH.teammateAgentSnippet, 'q')).toBeNull();
    bridgeUp = true;
  });

  it('gives the window a snippet in the shape of the app it asks for, and nothing for an unknown app', async () => {
    const zed = await call(SETTINGS_CH.teammateConnectSnippet, 'zed');
    expect(JSON.parse((zed as { text: string }).text)).toEqual({
      context_servers: { lolping: { command: { path: 'lolPing.exe', args: ['bridge.js'], env: { LOLPING_PIPE: 'P' } } } },
    });
    const goose = await call(SETTINGS_CH.teammateConnectSnippet, 'goose');
    expect(goose).toEqual({
      text: ['\'lolPing.exe\' \'bridge.js\'', '', 'Environment variables:', 'LOLPING_PIPE=P'].join('\n'),
    });
    for (const bad of ['nope', 5, null, { id: 'zed' }]) expect(await call(SETTINGS_CH.teammateConnectSnippet, bad)).toBeNull();
    bridgeUp = false;
    expect(await call(SETTINGS_CH.teammateConnectSnippet, 'zed')).toBeNull();
    bridgeUp = true;
  });

  it('lists the apps asked from and the editors installed', async () => {
    expect(await call(SETTINGS_CH.teammateRecentApps)).toEqual(['Code', 'chrome']);
    expect(await call(SETTINGS_CH.teammateEditors)).toEqual(['Code', 'idea64']);
  });

  it('validates teammate payloads', async () => {
    for (const [id, key] of [[1, KEY], ['nope', KEY], ['p1', 42], ['p1', 'x'.repeat(5000)], [null, null]]) {
      expect(await call(SETTINGS_CH.teammateSetKey, id, key)).toEqual({ ok: false });
    }
    expect(secrets?.key('p1')).toBeNull();
    expect(await call(SETTINGS_CH.teammateHasKey, { id: 'p1' })).toBe(false);
    expect(await call(SETTINGS_CH.teammateCheckKey, 'nope')).toMatchObject({ ok: false, error: 'other' });
    expect(await call(SETTINGS_CH.teammateCheckKey, 'p1')).toMatchObject({ ok: false, error: 'auth' }); // no key yet
    for (const raw of [5, null, 'x'.repeat(2001)]) {
      expect(await call(SETTINGS_CH.teammateSetInstructions, raw)).toEqual({ ok: false });
    }
    expect(await call(SETTINGS_CH.teammateInstructions)).toBe('');
    expect(await call(SETTINGS_CH.teammateSetInstructions, 'Call me Sam.')).toEqual({ ok: true });
    expect(await call(SETTINGS_CH.teammateInstructions)).toBe('Call me Sam.');
    for (const op of ['format', null, { op: 'clear' }]) await call(SETTINGS_CH.teammateHistory, op);
    expect(historyOps).toEqual([]);
    expect(await call(SETTINGS_CH.teammateHistory, 'clear')).toBe(true);
    expect(historyOps).toEqual(['clear']);
    clearFails = true;
    expect(await call(SETTINGS_CH.teammateHistory, 'clear')).toBe(false);
    expect(await call(SETTINGS_CH.teammateHistory, 'format')).toBe(false);

    secrets = null; // the feature is off: nothing is stored
    expect(await call(SETTINGS_CH.teammateSetKey, 'p1', KEY)).toEqual({ ok: false, error: 'unavailable' });
    expect(await call(SETTINGS_CH.teammateHasKey, 'p1')).toBe(false);
    expect(await call(SETTINGS_CH.teammateInstructions)).toBe('');
  });
});

describe('teammate IPC without keys', () => {
  it('checks a local server with no key, and says whether keys, history and screen capture are available', async () => {
    const keys: string[] = [];
    const local: BuiltinProfile = {
      id: 'local', kind: 'builtin', name: 'Ollama', tagColor: 3, tagColorCustom: null, provider: 'ollama',
      protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: '',
    };
    let available = true;
    const secrets = {
      available: () => available, key: () => null, hasKey: () => false,
      setKey: async () => undefined, instructions: () => '', setInstructions: async () => undefined,
    };
    let on = true;
    let screen: boolean | null = null;
    let opened = 0;
    store.update({ teammate: { ...store.get().teammate, profiles: [local] } });
    h.handlers.clear();
    registerSettingsIpc({
      store, library, text: () => strings('en'), platform: 'win', room: {},
      teammate: {
        secrets: () => (on ? secrets : null),
        adapter: (_p: BuiltinProfile, key: string) => ({ listModels: async () => (keys.push(key), ['llama3.2']) }),
        usage: () => ({ month: '2026-10', input: 0, output: 0 }),
        history: async () => true,
        screenAccess: () => screen,
        openScreenRecording: () => { opened += 1; },
      },
    } as unknown as SettingsIpcDeps);
    expect(await call(SETTINGS_CH.teammateCheckKey, 'local')).toEqual({ ok: true, models: ['llama3.2'] });
    expect(keys).toEqual(['']);

    expect(await call(SETTINGS_CH.teammateStatus)).toEqual({ secretsAvailable: true, screenAccess: null });
    available = false;
    expect(await call(SETTINGS_CH.teammateStatus)).toEqual({ secretsAvailable: false, screenAccess: null });
    on = false;
    expect(await call(SETTINGS_CH.teammateStatus)).toEqual({ secretsAvailable: false, screenAccess: null });

    screen = false; // macOS without Screen Recording
    expect(await call(SETTINGS_CH.teammateStatus)).toMatchObject({ screenAccess: false });
    await call(SETTINGS_CH.teammateOpenScreen);
    expect(opened).toBe(1);
  });
});
