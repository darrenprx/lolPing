import { LANGUAGE_PREFS, strings, type Lang, type LanguagePref } from './i18n';
import { HOTKEY_PRIMARY_MODS, MOD, type Hotkey, vkLabel } from './keys';
import { DEFAULT_CLICK_PING, DEFAULT_WHEEL, isPingId, type PingId } from './pings';
import type { Platform } from './platform';
import { isValidWheel } from './wheelLayout';

export type NamedTrigger = 'alt' | 'ctrl' | 'shift' | 'win' | 'capslock' | 'mouse4' | 'mouse5';
export type TriggerKey = NamedTrigger | { vk: number };
export const NAMED_TRIGGERS: readonly NamedTrigger[] = ['alt', 'ctrl', 'shift', 'win', 'capslock', 'mouse4', 'mouse5'];

/** Keyboard triggers offered. */
export const keyboardTriggers = (_platform: Platform): NamedTrigger[] =>
  ['alt', 'ctrl', 'shift', 'win', 'capslock'];

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
};

export const LIMITS = {
  dragThresholdPx: { min: 2, max: 40, step: 1 },
  pingSizePx: { min: 60, max: 220, step: 1 },
  pingDurationS: { min: 1, max: 8, step: 0.1 },
  volume: { min: 0, max: 100, step: 1 },
} as const;

type NumKey = keyof typeof LIMITS;
type BoolKey = 'enabledOnStart' | 'clickPing' | 'muted' | 'tickSound' | 'launchAtStartup';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isVk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 254;

function num(raw: unknown, key: NumKey): number {
  const { min, max, step } = LIMITS[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SETTINGS[key];
  const clamped = Math.min(max, Math.max(min, raw));
  return Number((Math.round(clamped / step) * step).toFixed(step < 1 ? 1 : 0));
}

const bool = (raw: unknown, key: BoolKey): boolean => (typeof raw === 'boolean' ? raw : DEFAULT_SETTINGS[key]);

function trigger(raw: unknown, _platform: Platform): TriggerKey {
  if (typeof raw === 'string' && (NAMED_TRIGGERS as readonly string[]).includes(raw)) return raw as NamedTrigger;
  if (isObj(raw) && isVk(raw.vk)) return { vk: raw.vk };
  return DEFAULT_SETTINGS.trigger;
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

/** Turns anything (parsed JSON, IPC payloads) into a complete, valid Settings object for `platform`. */
export function normalizeSettings(raw: unknown, platform: Platform = 'win'): Settings {
  const r = isObj(raw) ? raw : {};
  return {
    version: 1,
    enabledOnStart: bool(r.enabledOnStart, 'enabledOnStart'),
    trigger: trigger(r.trigger, platform),
    dragThresholdPx: num(r.dragThresholdPx, 'dragThresholdPx'),
    clickPing: bool(r.clickPing, 'clickPing'),
    clickPingId: isPingId(r.clickPingId) ? r.clickPingId : DEFAULT_CLICK_PING,
    wheel: isValidWheel(r.wheel) ? [...r.wheel] : [...DEFAULT_WHEEL],
    toggleHotkey: hotkey(r.toggleHotkey),
    pingSizePx: num(r.pingSizePx, 'pingSizePx'),
    pingDurationS: num(r.pingDurationS, 'pingDurationS'),
    volume: num(r.volume, 'volume'),
    muted: bool(r.muted, 'muted'),
    tickSound: bool(r.tickSound, 'tickSound'),
    launchAtStartup: bool(r.launchAtStartup, 'launchAtStartup'),
    language: (LANGUAGE_PREFS as readonly unknown[]).includes(r.language) ? (r.language as LanguagePref) : DEFAULT_SETTINGS.language,
  };
}

export function mergeSettings(current: Settings, patch: Partial<Settings>, platform: Platform = 'win'): Settings {
  return normalizeSettings({ ...current, ...patch }, platform);
}

type KeyTrigger = Exclude<NamedTrigger, 'mouse4' | 'mouse5'>;
const KEY_LABELS: Record<Platform, Record<KeyTrigger, string>> = {
  win: { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', win: 'Win', capslock: 'Caps Lock' },
};

export function triggerLabel(t: TriggerKey, lang: Lang = 'en', platform: Platform = 'win'): string {
  if (typeof t === 'object') return vkLabel(t.vk, platform);
  if (t === 'mouse4' || t === 'mouse5') return strings(lang)[t];
  return KEY_LABELS[platform][t];
}

export type OverlaySettings = Pick<Settings, 'pingSizePx' | 'pingDurationS' | 'volume' | 'muted' | 'tickSound' | 'wheel' | 'clickPingId'>;

export const overlaySettings = (s: Settings): OverlaySettings => ({
  pingSizePx: s.pingSizePx, pingDurationS: s.pingDurationS, volume: s.volume, muted: s.muted, tickSound: s.tickSound,
  wheel: [...s.wheel], clickPingId: s.clickPingId,
});
