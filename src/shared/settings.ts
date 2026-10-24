import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL } from './emoteCatalog';
import {
  CUSTOM_NAME_MAX, MAX_CUSTOM_EMOTES, customHash, isCustomRef, isEmoteFx, normalizeClickEmote, normalizeEmoteWheel,
  type CustomEmote, type EmoteRef,
} from './emotes';
import { DEFAULT_FEATURES, normalizeFeatures, type Features } from './features';
import { WHEEL } from './geometry';
import { LANGUAGE_PREFS, strings, type Lang, type LanguagePref } from './i18n';
import { HOTKEY_PRIMARY_MODS, MOD, type Hotkey, vkLabel } from './keys';
import { DEFAULT_CLICK_PING, DEFAULT_WHEEL, isPingId, type PingId } from './pings';
import type { Platform } from './platform';
import { isTagColor, isTagRgb, readableTagRgb, type TagRgb } from './roomColors';
import { parseRoomCode } from './roomCode';
import { sanitizeName } from './roomProtocol';
import { isVersion } from './update';
import { isValidWheel } from './wheelLayout';

export type NamedTrigger = 'alt' | 'ctrl' | 'shift' | 'win' | 'capslock' | 'mouse4' | 'mouse5';
export type TriggerKey = NamedTrigger | { vk: number };
/** The emote key is a trigger key, or 'off': then the emote wheel is off and can't be opened (nor can emote click). */
export type EmoteTriggerKey = TriggerKey | 'off';
export const NAMED_TRIGGERS: readonly NamedTrigger[] = ['alt', 'ctrl', 'shift', 'win', 'capslock', 'mouse4', 'mouse5'];

/** Keyboard triggers offered on each platform. macOS and X11 can't reliably stop Caps Lock from toggling, so only Windows offers it. */
export const keyboardTriggers = (platform: Platform): NamedTrigger[] =>
  platform !== 'win' ? ['alt', 'ctrl', 'shift', 'win'] : ['alt', 'ctrl', 'shift', 'win', 'capslock'];

export type RoomTextStyle = 'spot' | 'danmaku';

export interface Settings {
  version: 1;
  enabledOnStart: boolean;
  trigger: TriggerKey;
  dragThresholdPx: number;
  clickPing: boolean;
  /** Which ping trigger + click places. */
  clickPingId: PingId;
  /** Fullscreen apps (games) keep every click: trigger + click passes through while one is front. */
  gameCheck: boolean;
  /** Apps where lolPing stands down entirely, gestures and hotkeys alike: process names without .exe. */
  skipApps: string[];
  /** The displayed SVG size, shared by the ping and emote wheels. */
  wheelSizePx: number;
  /** The wheel's slices, top (N) then clockwise. */
  wheel: PingId[];
  toggleHotkey: Hotkey;
  /** Opens the custom text message dialog. */
  textHotkey: Hotkey;
  /** Held in a room to show the room panel: one key's virtual-key code, no modifiers. */
  panelKey: number;
  pingSizePx: number;
  pingDurationS: number;
  /** Your newest ping stays on screen until your next one or a pause (pings from the room still fade). */
  keepLastPing: boolean;
  volume: number;
  muted: boolean;
  tickSound: boolean;
  launchAtStartup: boolean;
  language: LanguagePref;
  /** Shown under your pings on other people's screens. */
  displayName: string;
  /** Index into TAG_COLORS. Ignored while `tagColorCustom` is set, and still what older builds are shown. */
  tagColor: number;
  /** A custom tag colour, or null to use the palette entry. Stored already clamped, so it is what everyone sees. */
  tagColorCustom: TagRgb | null;
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
  /** Fetch and show room members' custom emotes. Off: nothing is fetched or served, and their images show as the placeholder. */
  friendEmotes: boolean;
  /** Look for a new version on launch and every few hours. Checking by hand always works. */
  autoUpdateCheck: boolean;
  /** The newest version already announced with a toast, as x.y.z, so each version is announced once. */
  updateNotifiedVersion: string | null;
  /** Optional parts of the app that can be switched off; see features.ts. */
  features: Features;
  /** How room text appears here: a bubble at the spot the sender pointed at, or a line scrolling across the top. */
  roomTextStyle: RoomTextStyle;
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
  gameCheck: true,
  skipApps: [],
  clickPingId: DEFAULT_CLICK_PING,
  wheelSizePx: WHEEL.size,
  wheel: [...DEFAULT_WHEEL],
  toggleHotkey: { mods: MOD.ctrl | MOD.alt, vk: 0x50 },
  textHotkey: { mods: MOD.alt, vk: 0x54 },
  panelKey: 0x09,
  pingSizePx: 110,
  pingDurationS: 3.2,
  keepLastPing: false,
  volume: 70,
  muted: false,
  tickSound: true,
  launchAtStartup: false,
  language: 'auto',
  displayName: 'Player',
  tagColor: 0,
  tagColorCustom: null,
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
  friendEmotes: true,
  autoUpdateCheck: true,
  updateNotifiedVersion: null,
  features: { ...DEFAULT_FEATURES },
  roomTextStyle: 'spot',
};

export const LIMITS = {
  dragThresholdPx: { min: 2, max: 40, step: 1 },
  wheelSizePx: { min: 300, max: 900, step: 10 },
  pingSizePx: { min: 60, max: 220, step: 1 },
  pingDurationS: { min: 1, max: 8, step: 0.1 },
  volume: { min: 0, max: 100, step: 1 },
  incomingPingLimit: { min: 0, max: 20, step: 1 },
  emoteSizePx: { min: 80, max: 300, step: 1 },
} as const;

type NumKey = keyof typeof LIMITS;
type BoolKey = 'enabledOnStart' | 'clickPing' | 'gameCheck' | 'keepLastPing' | 'muted' | 'tickSound' | 'launchAtStartup' | 'allowInternet' | 'rejoinRoom' | 'roomMuted'
  | 'emoteClick' | 'emoteSound' | 'friendEmotes' | 'autoUpdateCheck';

/** At most MAX_SKIP_APPS entries: the list exists for a handful of apps. */
export const MAX_SKIP_APPS = 32;

/** One process name as the exception list stores it: trimmed, without a trailing ".exe". Case is kept for display;
 * every match, here and in the helper, ignores it. */
export const appNameStem = (name: string): string => {
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith('.exe') ? trimmed.slice(0, -4) : trimmed;
};

/**
 * What an exception entry should store for `input`: a running app's process name when the user typed the words the
 * system shows for it (an IME offers "网易UU远程", the process is GameViewer.exe), else the typed name as a stem.
 */
export const resolveSkipApp = (input: string, running: readonly { name: string; desc?: string }[]): string => {
  const typed = input.trim().toLowerCase();
  const match = running.find((a) => typeof a.desc === 'string' && a.desc.trim().toLowerCase() === typed);
  return match ? appNameStem(match.name) : appNameStem(input);
};

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
  if (platform !== 'win' && (raw === 'capslock' || (isObj(raw) && raw.vk === CAPS_LOCK_VK))) return fallback;
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

const pickKey = <K extends keyof Settings>(current: Settings, patch: Partial<Settings>, k: K): unknown =>
  (k in patch ? patch[k] : current[k]);

/** Whether `settings` (as a partial patch merged over `current`) puts the panel key on a ping, emote or shortcut key. */
function panelKeyTaken(current: Settings, patch: Partial<Settings>, platform: Platform): boolean {
  const pick = <K extends keyof Settings>(k: K): unknown => pickKey(current, patch, k);
  const ping = trigger(pick('trigger'), platform);
  const emote = emoteKey(pick('emoteTrigger'), platform);
  const taken = [
    triggerVk(ping), triggerVk(emote), hotkey(pick('toggleHotkey')).vk, hotkey(pick('textHotkey'), DEFAULT_SETTINGS.textHotkey).vk,
  ];
  return taken.includes(panelKey(pick('panelKey'), []));
}

/**
 * Whether applying `patch` newly puts the panel key on the key of the ping trigger, emote key or a shortcut, judged
 * as normalizeSettings will read them. A setup that already clashes can still save a patch that doesn't make it worse.
 */
export function panelKeyClashes(current: Settings, patch: Partial<Settings>, platform: Platform = 'win'): boolean {
  if (!(['trigger', 'emoteTrigger', 'toggleHotkey', 'textHotkey', 'panelKey'] as const).some((k) => k in patch)) return false;
  return panelKeyTaken(current, patch, platform) && !panelKeyTaken(current, {}, platform);
}

/**
 * Whether applying `patch` to `current` leaves those keys clashing, judged as normalizeSettings will read them. The text
 * shortcut may share a custom trigger's key: the helper matches its chord exactly — modifiers included — before the
 * trigger branch sees the key, and outside a live room it is not given the key at all (issue #100).
 */
export function patchClashes(current: Settings, patch: Partial<Settings>, platform: Platform = 'win'): boolean {
  const pick = <K extends 'trigger' | 'emoteTrigger' | 'toggleHotkey'>(k: K): unknown => pickKey(current, patch, k);
  const ping = trigger(pick('trigger'), platform);
  const emote = emoteKey(pick('emoteTrigger'), platform);
  if (triggersClash(ping, emote, hotkey(pick('toggleHotkey')))) return true;
  return panelKeyClashes(current, patch, platform);
}

function hotkey(raw: unknown, fallback: Hotkey = DEFAULT_SETTINGS.toggleHotkey): Hotkey {
  // Needs Ctrl, Alt or Win: a Shift-only hotkey would swallow ordinary capital letters system-wide.
  if (
    isObj(raw) && Number.isInteger(raw.mods) && (raw.mods as number) >= 1 && (raw.mods as number) <= 15
    && ((raw.mods as number) & HOTKEY_PRIMARY_MODS) !== 0 && isVk(raw.vk)
  ) {
    return { mods: raw.mods as number, vk: raw.vk };
  }
  return { ...fallback };
}

const hotkeysEqual = (a: Hotkey, b: Hotkey): boolean => a.mods === b.mods && a.vk === b.vk;
const MODIFIER_VKS: readonly number[] = [0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c];

/** Tab, then backquote and F2-F4: the first of these that isn't taken stands in for a rejected panel key. */
const PANEL_KEY_FALLBACKS: readonly number[] = [DEFAULT_SETTINGS.panelKey, 0xc0, 0x71, 0x72, 0x73];

/** A plain key that is not Esc, a modifier, or the key of another shortcut or custom trigger; else a free fallback. */
function panelKey(raw: unknown, taken: readonly (number | null)[]): number {
  if (isVk(raw) && raw !== 0x1b && !MODIFIER_VKS.includes(raw) && !taken.includes(raw)) return raw;
  // At most four keys are taken, so one of the five fallbacks is always free.
  return PANEL_KEY_FALLBACKS.find((k) => !taken.includes(k)) ?? DEFAULT_SETTINGS.panelKey;
}

const TEXT_HOTKEY_FALLBACK: Hotkey = { mods: MOD.alt, vk: 0x59 }; // Alt+Y when Alt+T is taken

function roomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseRoomCode(raw);
  return parsed.ok ? parsed.code : null;
}

/** Process names where lolPing stands down: trimmed, no .exe, no duplicate stems; the first MAX_SKIP_APPS. */
function skipApps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const e of raw) {
    if (out.length >= MAX_SKIP_APPS) break;
    if (typeof e !== 'string') continue;
    const stem = appNameStem(e);
    if (stem === '' || out.some((kept) => kept.toLowerCase() === stem.toLowerCase())) continue;
    out.push(stem);
  }
  return out;
}

/** Valid entries only, rebuilt field by field: well-formed unique ids, boolean flags, a safe name; the first MAX_CUSTOM_EMOTES. */
function customEmotes(raw: unknown): CustomEmote[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomEmote[] = [];
  for (const e of raw) {
    if (out.length >= MAX_CUSTOM_EMOTES) break;
    if (!isObj(e) || !isCustomRef(e.id) || typeof e.name !== 'string' || typeof e.animated !== 'boolean') continue;
    const id = e.id;
    if (out.some((c) => c.id === id)) continue;
    // A name with nothing left shows the first characters of its id, which reads the same in every language.
    const name = sanitizeName(e.name.slice(0, 256), customHash(id).slice(0, 6), CUSTOM_NAME_MAX);
    out.push({
      id, name, animated: e.animated,
      ...(e.sound === true ? { sound: true } : {}),
      ...(isEmoteFx(e.fx) ? { fx: e.fx } : {}),
    });
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
  const requestedTextHotkey = hotkey(r.textHotkey, DEFAULT_SETTINGS.textHotkey);
  const textHotkey = hotkeysEqual(toggleHotkey, requestedTextHotkey)
    ? { ...(hotkeysEqual(toggleHotkey, DEFAULT_SETTINGS.textHotkey) ? TEXT_HOTKEY_FALLBACK : DEFAULT_SETTINGS.textHotkey) }
    : requestedTextHotkey;
  const emote = emoteKey(r.emoteTrigger, platform);
  const emoteVk = triggerVk(triggersClash(pingTrigger, emote, toggleHotkey) ? 'off' : emote);
  const custom = customEmotes(r.customEmotes);
  return {
    version: 1,
    enabledOnStart: bool(r.enabledOnStart, 'enabledOnStart'),
    trigger: pingTrigger,
    dragThresholdPx: num(r.dragThresholdPx, 'dragThresholdPx'),
    clickPing: bool(r.clickPing, 'clickPing'),
    gameCheck: bool(r.gameCheck, 'gameCheck'),
    skipApps: skipApps(r.skipApps),
    wheelSizePx: num(r.wheelSizePx, 'wheelSizePx'),
    clickPingId: isPingId(r.clickPingId) ? r.clickPingId : DEFAULT_CLICK_PING,
    wheel: isValidWheel(r.wheel) ? [...r.wheel] : [...DEFAULT_WHEEL],
    toggleHotkey,
    textHotkey,
    panelKey: panelKey(r.panelKey, [triggerVk(pingTrigger), emoteVk, toggleHotkey.vk, textHotkey.vk]),
    pingSizePx: num(r.pingSizePx, 'pingSizePx'),
    pingDurationS: num(r.pingDurationS, 'pingDurationS'),
    keepLastPing: bool(r.keepLastPing, 'keepLastPing'),
    volume: num(r.volume, 'volume'),
    muted: bool(r.muted, 'muted'),
    tickSound: bool(r.tickSound, 'tickSound'),
    launchAtStartup: bool(r.launchAtStartup, 'launchAtStartup'),
    language: (LANGUAGE_PREFS as readonly unknown[]).includes(r.language) ? (r.language as LanguagePref) : DEFAULT_SETTINGS.language,
    displayName: typeof r.displayName === 'string' ? sanitizeName(r.displayName, fallbackName) : fallbackName,
    tagColor: isTagColor(r.tagColor) ? r.tagColor : isTagColor(identity.color) ? identity.color : 0,
    tagColorCustom: isTagRgb(r.tagColorCustom) ? readableTagRgb(r.tagColorCustom) : null,
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
    friendEmotes: bool(r.friendEmotes, 'friendEmotes'),
    autoUpdateCheck: bool(r.autoUpdateCheck, 'autoUpdateCheck'),
    updateNotifiedVersion: isVersion(r.updateNotifiedVersion) ? r.updateNotifiedVersion : null,
    features: normalizeFeatures(r.features),
    roomTextStyle: r.roomTextStyle === 'danmaku' ? 'danmaku' : 'spot',
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
  linux: { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', win: 'Super', capslock: 'Caps Lock' },
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
  'pingSizePx' | 'pingDurationS' | 'keepLastPing' | 'volume' | 'muted' | 'tickSound' | 'wheelSizePx' | 'wheel' | 'clickPingId'
  | 'emoteWheel' | 'clickEmoteId' | 'emoteSizePx' | 'emoteSound' | 'customEmotes'
>;

/** How loud lolPing's sounds play, 0 to 1: the volume setting, or 0 when muted. */
export const soundLevel = (s: Pick<Settings, 'volume' | 'muted'>): number => (s.muted ? 0 : s.volume / 100);

export const overlaySettings = (s: Settings): OverlaySettings => ({
  pingSizePx: s.pingSizePx, pingDurationS: s.pingDurationS, keepLastPing: s.keepLastPing, volume: s.volume, muted: s.muted, tickSound: s.tickSound,
  wheelSizePx: s.wheelSizePx, wheel: [...s.wheel], clickPingId: s.clickPingId,
  emoteWheel: [...s.emoteWheel], clickEmoteId: s.clickEmoteId, emoteSizePx: s.emoteSizePx, emoteSound: s.emoteSound,
  customEmotes: s.customEmotes.map((c) => ({ ...c })),
});
