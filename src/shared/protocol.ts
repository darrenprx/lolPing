import { featureOn } from './features';
import type { Settings } from './settings';

/** Which wheel a gesture belongs to: the ping trigger's or the emote key's. */
export type WheelKind = 'ping' | 'emote';

/**
 * Messages the hook helper writes to stdout, one JSON object per line.
 * Coordinates are physical pixels on Windows/Linux and global points (Electron DIPs) on macOS.
 */
export type HelperEvent =
  | { type: 'ready'; version: number }
  | { type: 'wheelOpen' | 'wheelMove' | 'wheelRelease' | 'click'; x: number; y: number; wheel: WheelKind }
  | { type: 'cancel' }
  | { type: 'toggled'; enabled: boolean }
  | { type: 'textRequested' }
  | { type: 'panel'; show: boolean }
  | { type: 'foregroundApp'; name: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'sim'; swallow: boolean; inject: string };

/** `noAccess`: macOS Accessibility access or a supported Linux X11 session is missing. */
export type HelperStatus = 'starting' | 'running' | 'failed' | 'noAccess';

/** The helper's exit code when OS input is unavailable (macOS permissions / unsupported Linux session). */
export const HELPER_EXIT_NO_ACCESS = 3;

type PointType = 'wheelOpen' | 'wheelMove' | 'wheelRelease' | 'click';
const POINT_TYPES = new Set<string>(['wheelOpen', 'wheelMove', 'wheelRelease', 'click']);
const isInt = (x: unknown): x is number => Number.isInteger(x);

export function parseHelperLine(line: string): HelperEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o.type) {
    case 'ready':
      return isInt(o.version) ? { type: 'ready', version: o.version } : null;
    case 'cancel':
      return { type: 'cancel' };
    case 'toggled':
      return typeof o.enabled === 'boolean' ? { type: 'toggled', enabled: o.enabled } : null;
    case 'textRequested':
      return { type: 'textRequested' };
    case 'panel':
      return typeof o.show === 'boolean' ? { type: 'panel', show: o.show } : null;
    case 'foregroundApp':
      return typeof o.name === 'string' ? { type: 'foregroundApp', name: o.name } : null;
    case 'error':
      if (typeof o.message !== 'string') return null;
      return typeof o.code === 'string' ? { type: 'error', message: o.message, code: o.code } : { type: 'error', message: o.message };
    case 'sim':
      return typeof o.swallow === 'boolean' && typeof o.inject === 'string'
        ? { type: 'sim', swallow: o.swallow, inject: o.inject }
        : null;
    default:
      if (typeof o.type === 'string' && POINT_TYPES.has(o.type) && isInt(o.x) && isInt(o.y)) {
        // Anything but "emote" (including no field, from a version 1 helper) is the ping wheel.
        return { type: o.type as PointType, x: o.x, y: o.y, wheel: o.wheel === 'emote' ? 'emote' : 'ping' };
      }
      return null;
  }
}

export type HelperTrigger = 'alt' | 'ctrl' | 'shift' | 'win' | 'capslock' | 'mouse4' | 'mouse5' | 'vk';

/** Messages Electron writes to the helper's stdin. Flat objects only: the C++ parser has no nesting. */
export type HelperCommand =
  | {
      type: 'config';
      trigger: HelperTrigger;
      triggerVk: number;
      clickPing: boolean;
      /** Fullscreen apps keep every click: no wheel gestures while one is in front. */
      gameCheck: boolean;
      /** Comma-separated process names where lolPing stands down entirely. Empty: every app gets gestures. */
      skipApps: string;
      /** 'off': no emote key, so no emote gestures. */
      emoteTrigger: HelperTrigger | 'off';
      emoteTriggerVk: number;
      emoteClick: boolean;
      dragThresholdPx: number;
      toggleMods: number;
      toggleVk: number;
      textMods: number;
      textVk: number;
      panelVk: number;
      enabled: boolean;
    }
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'suspend'; on: boolean }
  | { type: 'getForegroundApp' }
  | { type: 'shutdown' };

/**
 * `live.text` and `live.panel` are false outside a room: a key code of 0 tells the helper to leave that key
 * (the text shortcut, the panel key) to other apps.
 */
export function configCommand(
  s: Settings,
  enabled: boolean,
  live: { text: boolean; panel: boolean } = { text: false, panel: false },
): HelperCommand {
  const t = s.trigger;
  // With the Emotes feature off the helper gets no emote key, so no emote wheel or emote click.
  const e = featureOn(s, 'emotes') ? s.emoteTrigger : 'off';
  return {
    type: 'config',
    trigger: typeof t === 'object' ? 'vk' : t,
    triggerVk: typeof t === 'object' ? t.vk : 0,
    clickPing: s.clickPing,
    gameCheck: s.gameCheck,
    skipApps: s.skipApps.join(','),
    emoteTrigger: typeof e === 'object' ? 'vk' : e,
    emoteTriggerVk: typeof e === 'object' ? e.vk : 0,
    emoteClick: s.emoteClick && e !== 'off',
    dragThresholdPx: s.dragThresholdPx,
    toggleMods: s.toggleHotkey.mods,
    toggleVk: s.toggleHotkey.vk,
    textMods: s.textHotkey.mods,
    textVk: live.text ? s.textHotkey.vk : 0,
    panelVk: live.panel ? s.panelKey : 0,
    enabled,
  };
}

export const serializeCommand = (c: HelperCommand): string => `${JSON.stringify(c)}\n`;
