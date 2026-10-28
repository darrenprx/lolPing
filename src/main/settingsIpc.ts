import { globalShortcut, ipcMain, shell } from 'electron';
import { isCustomRef, isEmoteFx, isEmoteRefShape, type CustomEmote, type EmoteRef, type ImportResult, type SoundResult } from '../shared/emotes';
import type { Strings } from '../shared/i18n';
import {
  SETTINGS_CH, TEAMMATE_HISTORY_OPS, type About, type AppStatus, type CheckAgentResult, type CheckKeyResult,
  type SecretResult, type SetSettingsResult, type TeammateHistoryOp, type TeammateStatus, type UsageMonth,
} from '../shared/ipc';
import { hotkeyLabel, hotkeyToAccelerator, type Hotkey } from '../shared/keys';
import { pingById, type PingId } from '../shared/pings';
import type { Platform } from '../shared/platform';
import type { JoinResult, RoomState } from '../shared/room';
import { askKeyClashes, panelKeyClashes, patchClashes, rendererPatch } from '../shared/settings';
import { editSavedRooms } from '../shared/savedRooms';
import { AGENT_PRESETS } from '../shared/teammate/agents';
import { CONNECT_APPS, connectSnippet, mcpAddLine, type BridgeCommand } from '../shared/teammate/connectApps';
import { needsKey } from '../shared/teammate/providers';
import { isBuiltin, PATH_MAX, type AgentProfile, type BuiltinProfile } from '../shared/teammate/settings';
import type { UpdateState } from '../shared/update';
import { emoteFileFrom, type EmoteLibrary } from './emoteLibrary';
import type { SettingsStore } from './settingsStore';
import { ProviderError, type ProviderAdapter } from './teammate/providers/types';
import { INSTRUCTIONS_MAX_CHARS, type SecretStore } from './teammate/secrets';

const PROJECT_URL = 'https://github.com/darrenprx/lolPing';
/** Where "What's new" goes when no update is known. */
export const LATEST_RELEASE_URL = `${PROJECT_URL}/releases/latest`;

export interface SettingsIpcDeps {
  store: SettingsStore;
  /** Imported emotes' files. Only the import, remove, sound and fx handlers change `customEmotes`. */
  library: EmoteLibrary;
  getStatus(): AppStatus;
  setEnabled(on: boolean): void;
  preview(id: PingId): void;
  previewEmote(ref: EmoteRef): void;
  about(): About;
  retryHelper(): void;
  setCapturing(on: boolean): void;
  openAccessibility(): void;
  /** Strings in the app's current language. */
  text(): Strings;
  platform: Platform;
  /** The update checker. Absent in a development build without LOLPING_UPDATE_TEST_URL: the page then shows no update controls. */
  update?: {
    state(): UpdateState;
    /** The release notes link of the update that was found, kept through a failed download or install; null when none is known. */
    notesUrl(): string | null;
    /** A manual check. */
    check(): Promise<void>;
    /** Downloads and installs; settles when the install has been handed over, which is minutes later. */
    start(): Promise<void>;
  };
  room: {
    state(): RoomState;
    create(): Promise<void>;
    join(text: string): Promise<JoinResult>;
    leave(): void;
    mute(peer: string, on: boolean): void;
    clipboardCode(): Promise<string | null>;
    copyCode(): void;
    retryInternet(): void;
  };
  teammate: {
    /** null while the teammate feature is off: then no key or instructions are read or stored. */
    secrets(): Pick<SecretStore, 'available' | 'key' | 'hasKey' | 'setKey' | 'instructions' | 'setInstructions'> | null;
    adapter(p: BuiltinProfile, key: string): Pick<ProviderAdapter, 'listModels'>;
    usage(): UsageMonth;
    /** Resolves true when the operation was carried out. */
    history(op: TeammateHistoryOp): Promise<boolean>;
    /** macOS: whether Screen Recording is allowed; null on other systems, which need no permission. */
    screenAccess(): boolean | null;
    openScreenRecording(): void;
    /** Runs the agent's command with --version. */
    checkAgent(p: AgentProfile): Promise<CheckAgentResult>;
    /** The system folder picker over the settings window; null when cancelled. */
    pickFolder(): Promise<string | null>;
    /** The JSON to paste into an agent's own MCP file; null when the pipe name can't be worked out. */
    agentSnippet(): string | null;
    /** How an agent started by the user's own app runs the bridge; null when the pipe name can't be worked out. */
    bridge(): BridgeCommand | null;
    /** Foreground app names of this session's asks, newest first. */
    recentApps(): readonly string[];
    /** The editors found on this computer. */
    editors(): Promise<string[]>;
  };
}

/** Longer than any provider's key; anything longer is not a key. */
const KEY_MAX = 4096;
const CHECK_KEY_MS = 15_000;

const sameHotkey = (a: Hotkey, b: Hotkey): boolean => a.mods === b.mods && a.vk === b.vk;

/** Returns an error message when another app already owns this shortcut. */
function hotkeyConflict(next: Hotkey, current: Hotkey, text: Strings, platform: Platform): string | null {
  if (next.mods === current.mods && next.vk === current.vk) return null;
  const accelerator = hotkeyToAccelerator(next);
  if (!accelerator) return null;
  try {
    const free = globalShortcut.register(accelerator, () => undefined);
    if (free) globalShortcut.unregister(accelerator);
    return free ? null : text.hotkeyTaken(hotkeyLabel(next, platform));
  } catch {
    return null;
  }
}

export function registerSettingsIpc(d: SettingsIpcDeps): void {
  // Imports and removals run one at a time, so each sees the list the one before it left (the duplicate and full checks).
  let emoteQueue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = emoteQueue.then(fn);
    emoteQueue = run.catch(() => undefined);
    return run;
  };

  ipcMain.handle(SETTINGS_CH.get, () => d.store.get());
  ipcMain.handle(SETTINGS_CH.set, (_e, raw: unknown): SetSettingsResult => {
    const patch = rendererPatch(raw);
    if (panelKeyClashes(d.store.get(), patch, d.platform)) {
      return { ok: false, error: d.text().panelKeyClash, settings: d.store.get() };
    }
    if (patchClashes(d.store.get(), patch, d.platform)) {
      return { ok: false, error: d.text().emoteKeyClash, settings: d.store.get() };
    }
    if (askKeyClashes(d.store.get(), patch, d.platform)) {
      return { ok: false, error: d.text().teammate.settings.askKeyClash, settings: d.store.get() };
    }
    if (patch.toggleHotkey) {
      if (sameHotkey(patch.toggleHotkey, patch.textHotkey ?? d.store.get().textHotkey)) {
        return { ok: false, error: d.text().shortcutClash, settings: d.store.get() };
      }
      const error = hotkeyConflict(patch.toggleHotkey, d.store.get().toggleHotkey, d.text(), d.platform);
      if (error) return { ok: false, error, settings: d.store.get() };
    }
    if (patch.textHotkey) {
      if (sameHotkey(patch.textHotkey, patch.toggleHotkey ?? d.store.get().toggleHotkey)) {
        return { ok: false, error: d.text().shortcutClash, settings: d.store.get() };
      }
      const error = hotkeyConflict(patch.textHotkey, d.store.get().textHotkey, d.text(), d.platform);
      if (error) return { ok: false, error, settings: d.store.get() };
    }
    return { ok: true, settings: d.store.update(patch) };
  });
  ipcMain.handle(SETTINGS_CH.status, () => d.getStatus());
  ipcMain.handle(SETTINGS_CH.setEnabled, (_e, on: unknown) => d.setEnabled(on === true));
  ipcMain.handle(SETTINGS_CH.preview, (_e, id: unknown) => {
    const p = typeof id === 'string' ? pingById(id) : undefined;
    if (p) d.preview(p.id);
  });
  ipcMain.handle(SETTINGS_CH.previewEmote, (_e, ref: unknown) => {
    if (isEmoteRefShape(ref)) d.previewEmote(ref);
  });
  ipcMain.handle(SETTINGS_CH.emoteImport, (_e, raw: unknown) => oneAtATime(async (): Promise<ImportResult> => {
    const file = emoteFileFrom(raw);
    if (!file) return { ok: false, error: 'type' };
    const saved = await d.library.save(file, d.store.get().customEmotes);
    if (!saved.ok) return { ok: false, error: saved.error };
    d.store.update({ customEmotes: [...d.store.get().customEmotes, saved.emote] });
    return { ok: true, id: saved.emote.id };
  }));
  ipcMain.handle(SETTINGS_CH.emoteRemove, (_e, id: unknown) => oneAtATime(async () => {
    if (!isCustomRef(id)) return;
    await d.library.remove(id);
    // Normalising the shorter list puts each wheel slot (and the click emote) that used it back to a default.
    d.store.update({ customEmotes: d.store.get().customEmotes.filter((c) => c.id !== id) });
  }));
  ipcMain.handle(SETTINGS_CH.emoteSound, (_e, id: unknown, raw: unknown) => oneAtATime(async (): Promise<SoundResult> => {
    if (!isCustomRef(id) || !d.store.get().customEmotes.some((c) => c.id === id)) return { ok: false, error: 'type' };
    if (raw !== null && !(raw instanceof Uint8Array)) return { ok: false, error: 'type' };
    const error = await d.library.setSound(id, raw);
    if (error) return { ok: false, error };
    const withSound = ({ sound: _old, ...c }: CustomEmote): CustomEmote => (raw === null ? c : { ...c, sound: true });
    d.store.update({ customEmotes: d.store.get().customEmotes.map((c) => (c.id === id ? withSound(c) : c)) });
    return { ok: true };
  }));
  ipcMain.handle(SETTINGS_CH.emoteFx, (_e, id: unknown, fx: unknown) => {
    // undefined is a choice too: it puts the emote back to the plain pop.
    if (!isCustomRef(id) || !(fx === undefined || isEmoteFx(fx))) return;
    d.store.update({ customEmotes: d.store.get().customEmotes.map((c) => (c.id === id ? { ...c, fx } : c)) });
  });
  ipcMain.handle(SETTINGS_CH.about, () => d.about());
  ipcMain.handle(SETTINGS_CH.openFolder, async () => {
    await shell.openPath(d.store.dir);
  });
  ipcMain.handle(SETTINGS_CH.openProject, async () => {
    await shell.openExternal(PROJECT_URL);
  });
  ipcMain.handle(SETTINGS_CH.retryHelper, () => d.retryHelper());
  ipcMain.handle(SETTINGS_CH.capture, (_e, on: unknown) => d.setCapturing(on === true));
  ipcMain.handle(SETTINGS_CH.openAccessibility, () => d.openAccessibility());
  ipcMain.handle(SETTINGS_CH.roomGet, () => d.room.state());
  ipcMain.handle(SETTINGS_CH.roomCreate, () => d.room.create());
  ipcMain.handle(SETTINGS_CH.roomJoin, (_e, text: unknown): Promise<JoinResult> | JoinResult =>
    typeof text === 'string' ? d.room.join(text) : { ok: false, error: 'invalid' });
  ipcMain.handle(SETTINGS_CH.roomLeave, () => d.room.leave());
  ipcMain.handle(SETTINGS_CH.roomSavedEdit, (_e, edit: unknown): boolean => {
    const savedRooms = editSavedRooms(d.store.get().savedRooms, edit);
    if (!savedRooms) return false;
    d.store.update({ savedRooms });
    return true;
  });
  ipcMain.handle(SETTINGS_CH.roomMute, (_e, peer: unknown, on: unknown) => {
    if (typeof peer === 'string') d.room.mute(peer, on === true);
  });
  ipcMain.handle(SETTINGS_CH.roomClipboard, () => d.room.clipboardCode());
  ipcMain.handle(SETTINGS_CH.roomCopy, () => d.room.copyCode());
  ipcMain.handle(SETTINGS_CH.roomRetryInternet, () => d.room.retryInternet());

  registerTeammateIpc(d);

  ipcMain.handle(SETTINGS_CH.updateGet, (): UpdateState | null => d.update?.state() ?? null);
  ipcMain.handle(SETTINGS_CH.updateCheck, async () => {
    await d.update?.check();
  });
  ipcMain.handle(SETTINGS_CH.updateStart, () => {
    // Not awaited: the page follows the download through update:state, and this call would otherwise stay open for minutes.
    d.update?.start().catch(() => undefined);
  });
  ipcMain.handle(SETTINGS_CH.updateOpenRelease, async () => {
    if (!d.update) return;
    const notes = d.update.notesUrl();
    await shell.openExternal(notes !== null && isWebUrl(notes) ? notes : LATEST_RELEASE_URL);
  });
}

/** Keys go in and never come back out: the window learns only whether a profile has one, and what Check key found. */
function registerTeammateIpc(d: SettingsIpcDeps): void {
  const profileOf = (id: unknown): BuiltinProfile | null =>
    typeof id === 'string' ? d.store.get().teammate.profiles.filter(isBuiltin).find((p) => p.id === id) ?? null : null;
  const agentOf = (id: unknown): AgentProfile | null => {
    const found = typeof id === 'string' ? d.store.get().teammate.profiles.find((p) => p.id === id) : undefined;
    return found?.kind === 'agent' ? found : null;
  };
  const stored = async (write: () => Promise<void>): Promise<SecretResult> => {
    try {
      await write();
      return { ok: true };
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  };

  ipcMain.handle(SETTINGS_CH.teammateSetKey, (_e, id: unknown, key: unknown): Promise<SecretResult> | SecretResult => {
    const profile = profileOf(id);
    if (!profile || typeof key !== 'string' || key.length > KEY_MAX) return { ok: false };
    const secrets = d.teammate.secrets();
    if (!secrets) return { ok: false, error: 'unavailable' };
    return stored(() => secrets.setKey(profile.id, key.trim()));
  });
  ipcMain.handle(SETTINGS_CH.teammateHasKey, (_e, id: unknown): boolean => {
    const profile = profileOf(id);
    return profile !== null && (d.teammate.secrets()?.hasKey(profile.id) ?? false);
  });
  ipcMain.handle(SETTINGS_CH.teammateCheckKey, async (_e, id: unknown): Promise<CheckKeyResult> => {
    const t = d.text().teammate.settings;
    const profile = profileOf(id);
    if (!profile) return { ok: false, error: 'other', message: t.checkNoProfile };
    const key = d.teammate.secrets()?.key(profile.id) ?? (needsKey(profile) ? null : '');
    if (key === null) return { ok: false, error: 'auth', message: t.checkNoKey };
    try {
      const models = await d.teammate.adapter(profile, key).listModels(AbortSignal.timeout(CHECK_KEY_MS));
      return { ok: true, models };
    } catch (err) {
      const kind = err instanceof ProviderError ? err.kind : 'other';
      const error = kind === 'auth' || kind === 'network' ? kind : 'other';
      // Some providers repeat the refused key in their message.
      const message = err instanceof Error ? (key ? err.message.split(key).join('…') : err.message) : '';
      return { ok: false, error, message };
    }
  });
  ipcMain.handle(SETTINGS_CH.teammateSetInstructions, (_e, text: unknown): Promise<SecretResult> | SecretResult => {
    if (typeof text !== 'string' || text.length > INSTRUCTIONS_MAX_CHARS) return { ok: false };
    const secrets = d.teammate.secrets();
    if (!secrets) return { ok: false, error: 'unavailable' };
    return stored(() => secrets.setInstructions(text));
  });
  ipcMain.handle(SETTINGS_CH.teammateInstructions, (): string => d.teammate.secrets()?.instructions() ?? '');
  ipcMain.handle(SETTINGS_CH.teammateUsage, (): UsageMonth => d.teammate.usage());
  ipcMain.handle(SETTINGS_CH.teammateHistory, async (_e, op: unknown): Promise<boolean> => {
    const known = TEAMMATE_HISTORY_OPS.find((o) => o === op);
    return known ? d.teammate.history(known).catch(() => false) : false;
  });
  ipcMain.handle(SETTINGS_CH.teammateStatus, (): TeammateStatus => ({
    secretsAvailable: d.teammate.secrets()?.available() ?? false,
    screenAccess: d.teammate.screenAccess(),
  }));
  ipcMain.handle(SETTINGS_CH.teammateOpenScreen, () => d.teammate.openScreenRecording());
  // The command is read from the saved profile, never taken from the window.
  ipcMain.handle(SETTINGS_CH.teammateCheckAgent, async (_e, id: unknown): Promise<CheckAgentResult> => {
    const profile = agentOf(id);
    if (!profile) return { ok: false, reason: 'failed', detail: d.text().teammate.settings.checkNoProfile };
    return d.teammate.checkAgent(profile).catch((): CheckAgentResult => ({ ok: false, reason: 'failed', detail: '' }));
  });
  ipcMain.handle(SETTINGS_CH.teammatePickFolder, async (): Promise<string | null> => {
    const picked: unknown = await d.teammate.pickFolder().catch(() => null);
    return typeof picked === 'string' && picked !== '' && picked.length <= PATH_MAX ? picked : null;
  });
  // By the saved profile's preset: one with an MCP file gets the JSON, one with only `<bin> mcp add` gets that line.
  ipcMain.handle(SETTINGS_CH.teammateAgentSnippet, (_e, id: unknown): { text: string } | null => {
    const profile = agentOf(id);
    const preset = profile && profile.preset !== 'custom' ? AGENT_PRESETS[profile.preset] : null;
    if (!preset) return null;
    if (preset.mcp === 'user' && preset.userConfig === undefined) {
      const bridge = d.teammate.bridge();
      return bridge ? { text: mcpAddLine(preset.bin, bridge, d.platform) } : null;
    }
    const json = d.teammate.agentSnippet();
    return json === null ? null : { text: json };
  });
  // The shape comes from the app's own row, never from the window.
  ipcMain.handle(SETTINGS_CH.teammateConnectSnippet, (_e, id: unknown): { text: string } | null => {
    const app = typeof id === 'string' ? CONNECT_APPS.find((a) => a.id === id) : undefined;
    const bridge = app ? d.teammate.bridge() : null;
    return app && bridge ? { text: connectSnippet(app.shape, bridge, d.platform, d.text().teammate.settings.connectEnvLabel) } : null;
  });
  ipcMain.handle(SETTINGS_CH.teammateRecentApps, (): string[] => [...d.teammate.recentApps()]);
  ipcMain.handle(SETTINGS_CH.teammateEditors, (): Promise<string[]> => d.teammate.editors().catch(() => []));
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
