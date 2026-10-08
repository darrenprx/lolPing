import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL } from './emoteCatalog';
import {
  CUSTOM_NAME_MAX, MAX_CUSTOM_EMOTES, customHash, isCustomRef, normalizeClickEmote, normalizeEmoteWheel,
  type CustomEmote, type EmoteRef,
} from './emotes';
import { LANGUAGE_PREFS, strings, type Lang, type LanguagePref } from './i18n';
import { HOTKEY_PRIMARY_MODS, MOD, type Hotkey, vkLabel } from './keys';
import { DEFAULT_CLICK_PING, DEFAULT_WHEEL, isPingId, type PingId } from './pings';
import type { Platform } from './platform';
import { isTagColor } from './roomColors';
import { parseRoomCode } from './roomCode';
import { sanitizeName } from './roomProtocol';
import { isVersion } from './update';
import { isValidWheel } from './wheelLayout';

export type NamedTrigger = 'alt' | 'ctrl' | 'shift' | 'win' | 'capslock' | 'mouse4' | 'mouse5';
export type TriggerKey = NamedTrigger | { vk: number };
/** The emote key is a trigger key, or 'off': then the emote wheel is off and can't be opened (nor can emote click). */
export type EmoteTriggerKey = TriggerKey | 'off';
export const NAMED_TRIGGERS: readonly NamedTrigger[] = ['alt', 'ctrl', 'shift', 'win', 'capslock', 'mouse4', 'mouse5'];

/** Keyboard triggers offered on each platform. macOS can't reliably stop Caps Lock from toggling, so it isn't offered. */
export const keyboardTriggers = (platform: Platform): NamedTrigger[] =>
  platform === 'mac' ? ['alt', 'ctrl', 'shift', 'win'] : ['alt', 'ctrl', 'shift', 'win', 'capslock'];

export interface Settings {
  version: 1;
  enabledOnStart: boolean;
  trigger: TriggerKey;
  dragThresholdPx: number;
  clickPing: boolean;
  /** Which ping trigger + click places. */
  clickPingId: PingId;
  /** The wheel's slices, top (N) then clockwise. */
  wheel: PingId[];
  toggleHotkey: Hotkey;
  pingSizePx: number;
  pingDurationS: number;
  volume: number;
  muted: boolean;
  tickSound: boolean;
  launchAtStartup: boolean;
  language: LanguagePref;
  /** Shown under your pings on other people's screens. */
  displayName: string;
  /** Index into TAG_COLORS. */
  tagColor: number;
  /** Pings per second accepted from each room member; 0 = unlimited. */
  incomingPingLimit: number;
  allowInternet: boolean;
  rejoinRoom: boolean;
  /** Canonical code of the room to rejoin on launch. */
  lastRoomCode: string | null;
  roomMuted: boolean;
  /** Held with a click-drag to open the emote wheel; 'off' turns the emote wheel off. Never the same key as `trigger`, and a custom key or Caps Lock is never the pause shortcut's key either. */
  emoteTrigger: EmoteTriggerKey;
  /** The emote key + click places `clickEmoteId`, like clickPing does for pings. */
  emoteClick: boolean;
  /** The emote wheel's slots, top (N) then clockwise: 8 distinct bundled slugs or imported emotes. */
  emoteWheel: EmoteRef[];
  clickEmoteId: EmoteRef;
  emoteSizePx: number;
  emoteSound: boolean;
  /** Imported emotes, at most MAX_CUSTOM_EMOTES. Their files live in the data folder. */
  customEmotes: CustomEmote[];
  /** Look for a new version on launch and every few hours. Checking by hand always works. */
  autoUpdateCheck: boolean;
  /** The newest version already announced with a toast, as x.y.z, so each version is announced once. */
  updateNotifiedVersion: string | null;
}

/** Per-machine defaults for the room profile: the OS username and a random tag colour. */
export interface Identity {
  name: string;
  color: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  enabledOnStart: true,
  trigger: 'alt',
  dragThresholdPx: 8,
  clickPing: false,
  clickPingId: DEFAULT_CLICK_PING,
  wheel: [...DEFAULT_WHEEL],
  toggleHotkey: { mods: MOD.ctrl | MOD.alt, vk: 0x50 },
  pingSizePx: 110,
  pingDurationS: 3.2,
  volume: 70,
  muted: false,
  tickSound: true,
  launchAtStartup: false,
  language: 'auto',
  displayName: 'Player',
  tagColor: 0,
  incomingPingLimit: 5,
  allowInternet: true,
  rejoinRoom: true,
  lastRoomCode: null,
  roomMuted: false,
  emoteTrigger: 'ctrl',
  emoteClick: false,
  emoteWheel: [...DEFAULT_EMOTE_WHEEL],
  clickEmoteId: DEFAULT_CLICK_EMOTE,
  emoteSizePx: 150,
  emoteSound: true,
  customEmotes: [],
  autoUpdateCheck: true,
  updateNotifiedVersion: null,
};

export const LIMITS = {
  dragThresholdPx: { min: 2, max: 40, step: 1 },
  pingSizePx: { min: 60, max: 220, step: 1 },
  pingDurationS: { min: 1, max: 8, step: 0.1 },
  volume: { min: 0, max: 100, step: 1 },
  incomingPingLimit: { min: 0, max: 20, step: 1 },
  emoteSizePx: { min: 80, max: 300, step: 1 },
} as const;

type NumKey = keyof typeof LIMITS;
type BoolKey = 'enabledOnStart' | 'clickPing' | 'muted' | 'tickSound' | 'launchAtStartup' | 'allowInternet' | 'rejoinRoom' | 'roomMuted'
  | 'emoteClick' | 'emoteSound' | 'autoUpdateCheck';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isVk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 254;

function num(raw: unknown, key: NumKey): number {
  const { min, max, step } = LIMITS[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SETTINGS[key];
  const clamped = Math.min(max, Math.max(min, raw));
  return Number((Math.round(clamped / step) * step).toFixed(step < 1 ? 1 : 0));
}

const bool = (raw: unknown, key: BoolKey): boolean => (typeof raw === 'boolean' ? raw : DEFAULT_SETTINGS[key]);

function triggerKey(raw: unknown, platform: Platform, fallback: TriggerKey): TriggerKey {
  if (platform === 'mac' && raw === 'capslock') return fallback;
  if (typeof raw === 'string' && (NAMED_TRIGGERS as readonly string[]).includes(raw)) return raw as NamedTrigger;
  if (isObj(raw) && isVk(raw.vk)) return { vk: raw.vk };
  return fallback;
}

const trigger = (raw: unknown, platform: Platform): TriggerKey => triggerKey(raw, platform, DEFAULT_SETTINGS.trigger);

/** The emote key as stored, before the clash rules: 'off', or a trigger key with Ctrl as the fallback. */
const emoteKey = (raw: unknown, platform: Platform): EmoteTriggerKey => (raw === 'off' ? 'off' : triggerKey(raw, platform, 'ctrl'));

/** The Caps Lock key's code: the named 'capslock' trigger and a custom { vk: 0x14 } are one physical key. */
const CAPS_LOCK_VK = 0x14;
/** The key code a trigger stands for when it is a custom key or Caps Lock; null for every other trigger. */
export const triggerVk = (t: EmoteTriggerKey): number | null => (typeof t === 'object' ? t.vk : t === 'capslock' ? CAPS_LOCK_VK : null);

export function sameTrigger(a: EmoteTriggerKey, b: EmoteTriggerKey): boolean {
  const x = triggerVk(a);
  const y = triggerVk(b);
  return x !== null && y !== null ? x === y : a === b;
}

/** The ping trigger and the emote key can't be one key, and the emote key can't be the pause shortcut's key. */
export function triggersClash(ping: TriggerKey, emote: EmoteTriggerKey, toggle: Hotkey): boolean {
  if (emote === 'off') return false;
  const vk = triggerVk(emote); // a custom key or Caps Lock; the modifier and mouse triggers can't be a shortcut's key
  return sameTrigger(ping, emote) || (vk !== null && vk === toggle.vk);
}

/** Whether applying `patch` to `current` leaves those three keys clashing, judged as normalizeSettings will read them. */
export function patchClashes(current: Settings, patch: Partial<Settings>, platform: Platform = 'win'): boolean {
  const pick = <K extends 'trigger' | 'emoteTrigger' | 'toggleHotkey'>(k: K): unknown => (k in patch ? patch[k] : current[k]);
  return triggersClash(trigger(pick('trigger'), platform), emoteKey(pick('emoteTrigger'), platform), hotkey(pick('toggleHotkey')));
}

function hotkey(raw: unknown): Hotkey {
  // Needs Ctrl, Alt or Win: a Shift-only hotkey would swallow ordinary capital letters system-wide.
  if (
    isObj(raw) && Number.isInteger(raw.mods) && (raw.mods as number) >= 1 && (raw.mods as number) <= 15
    && ((raw.mods as number) & HOTKEY_PRIMARY_MODS) !== 0 && isVk(raw.vk)
  ) {
    return { mods: raw.mods as number, vk: raw.vk };
  }
  return { ...DEFAULT_SETTINGS.toggleHotkey };
}

function roomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseRoomCode(raw);
  return parsed.ok ? parsed.code : null;
}

/** Valid entries only, rebuilt field by field: well-formed unique ids, a boolean flag, a safe name; the first MAX_CUSTOM_EMOTES. */
function customEmotes(raw: unknown): CustomEmote[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomEmote[] = [];
  for (const e of raw) {
    if (out.length >= MAX_CUSTOM_EMOTES) break;
    if (!isObj(e) || !isCustomRef(e.id) || typeof e.name !== 'string' || typeof e.animated !== 'boolean') continue;
    const id = e.id;
    if (out.some((c) => c.id === id)) continue;
    // A name with nothing left shows the first characters of its id, which reads the same in every language.
    out.push({ id, name: sanitizeName(e.name.slice(0, 256), customHash(id).slice(0, 6), CUSTOM_NAME_MAX), animated: e.animated });
  }
  return out;
}

const DEFAULT_IDENTITY: Identity = { name: DEFAULT_SETTINGS.displayName, color: DEFAULT_SETTINGS.tagColor };

/** Turns anything (parsed JSON, IPC payloads) into a complete, valid Settings object for `platform`. */
export function normalizeSettings(raw: unknown, platform: Platform = 'win', identity: Identity = DEFAULT_IDENTITY): Settings {
  const r = isObj(raw) ? raw : {};
  const fallbackName = sanitizeName(identity.name);
  const pingTrigger = trigger(r.trigger, platform);
  const toggleHotkey = hotkey(r.toggleHotkey);
  const emote = emoteKey(r.emoteTrigger, platform);
  const custom = customEmotes(r.customEmotes);
  return {
    version: 1,
    enabledOnStart: bool(r.enabledOnStart, 'enabledOnStart'),
    trigger: pingTrigger,
    dragThresholdPx: num(r.dragThresholdPx, 'dragThresholdPx'),
    clickPing: bool(r.clickPing, 'clickPing'),
    clickPingId: isPingId(r.clickPingId) ? r.clickPingId : DEFAULT_CLICK_PING,
    wheel: isValidWheel(r.wheel) ? [...r.wheel] : [...DEFAULT_WHEEL],
    toggleHotkey,
    pingSizePx: num(r.pingSizePx, 'pingSizePx'),
    pingDurationS: num(r.pingDurationS, 'pingDurationS'),
    volume: num(r.volume, 'volume'),
    muted: bool(r.muted, 'muted'),
    tickSound: bool(r.tickSound, 'tickSound'),
    launchAtStartup: bool(r.launchAtStartup, 'launchAtStartup'),
    language: (LANGUAGE_PREFS as readonly unknown[]).includes(r.language) ? (r.language as LanguagePref) : DEFAULT_SETTINGS.language,
    displayName: typeof r.displayName === 'string' ? sanitizeName(r.displayName, fallbackName) : fallbackName,
    tagColor: isTagColor(r.tagColor) ? r.tagColor : isTagColor(identity.color) ? identity.color : 0,
    incomingPingLimit: num(r.incomingPingLimit, 'incomingPingLimit'),
    allowInternet: bool(r.allowInternet, 'allowInternet'),
    rejoinRoom: bool(r.rejoinRoom, 'rejoinRoom'),
    lastRoomCode: roomCode(r.lastRoomCode),
    roomMuted: bool(r.roomMuted, 'roomMuted'),
    emoteTrigger: triggersClash(pingTrigger, emote, toggleHotkey) ? 'off' : emote,
    emoteClick: bool(r.emoteClick, 'emoteClick'),
    emoteWheel: normalizeEmoteWheel(r.emoteWheel, custom),
    clickEmoteId: normalizeClickEmote(r.clickEmoteId, custom),
    emoteSizePx: num(r.emoteSizePx, 'emoteSizePx'),
    emoteSound: bool(r.emoteSound, 'emoteSound'),
    customEmotes: custom,
    autoUpdateCheck: bool(r.autoUpdateCheck, 'autoUpdateCheck'),
    updateNotifiedVersion: isVersion(r.updateNotifiedVersion) ? r.updateNotifiedVersion : null,
  };
}

export function mergeSettings(current: Settings, patch: Partial<Settings>, platform: Platform = 'win', identity?: Identity): Settings {
  return normalizeSettings({ ...current, ...patch }, platform, identity);
}

/**
 * A patch from the settings window, before it is merged. Imported emotes are left out: they change only through importing
 * and removing, which check the files behind them. `updateNotifiedVersion` is the update checker's own note (which version
 * it already announced), so the window can't set it either. Anything that isn't an object changes nothing.
 */
export function rendererPatch(raw: unknown): Partial<Settings> {
  if (!isObj(raw)) return {};
  const { customEmotes: _emotes, updateNotifiedVersion: _notified, ...patch } = raw;
  return patch as Partial<Settings>;
}

type KeyTrigger = Exclude<NamedTrigger, 'mouse4' | 'mouse5'>;
const KEY_LABELS: Record<Platform, Record<KeyTrigger, string>> = {
  win: { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', win: 'Win', capslock: 'Caps Lock' },
  mac: { alt: '⌥ Option', ctrl: '⌃ Control', shift: '⇧ Shift', win: '⌘ Command', capslock: '⇪ Caps Lock' },
};

export function triggerLabel(t: TriggerKey, lang: Lang = 'en', platform: Platform = 'win'): string {
  if (typeof t === 'object') return vkLabel(t.vk, platform);
  if (t === 'mouse4' || t === 'mouse5') return strings(lang)[t];
  return KEY_LABELS[platform][t];
}

export type OverlaySettings = Pick<
  Settings,
  'pingSizePx' | 'pingDurationS' | 'volume' | 'muted' | 'tickSound' | 'wheel' | 'clickPingId'
  | 'emoteWheel' | 'clickEmoteId' | 'emoteSizePx' | 'emoteSound' | 'customEmotes'
>;

export const overlaySettings = (s: Settings): OverlaySettings => ({
  pingSizePx: s.pingSizePx, pingDurationS: s.pingDurationS, volume: s.volume, muted: s.muted, tickSound: s.tickSound,
  wheel: [...s.wheel], clickPingId: s.clickPingId,
  emoteWheel: [...s.emoteWheel], clickEmoteId: s.clickEmoteId, emoteSizePx: s.emoteSizePx, emoteSound: s.emoteSound,
  customEmotes: s.customEmotes.map((c) => ({ ...c })),
});
