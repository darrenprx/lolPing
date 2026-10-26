import { featureOn } from './features';
import type { Settings } from './settings';
import { canDoubleTap } from './teammate/settings';

/** Which wheel a gesture belongs to: the ping trigger's, the emote key's or the teammate's ask key. */
export type WheelKind = 'ping' | 'emote' | 'ask';

/**
 * The helper's `ready` version this build expects. 5: the ask key, `"wheel":"ask"` and `triggerUp`.
 * 6 adds `askWords`, `scroll`, the `askDoubleTap` config field and the `staleWatch` command.
 * 7 adds the app-exception list: the `skipApps` config field, the `foregroundApp` and `appList` events
 * and the `getForegroundApp` and `getAppList` commands.
 */
export const HELPER_VERSION = 7;

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
  /** A wheel's trigger key came up after a release or click while held, or right after a release it was let go before. */
  | { type: 'triggerUp'; wheel: WheelKind }
  /** The ask key was double-tapped: open the words box here. */
  | { type: 'askWords'; x: number; y: number }
  /** A scroll while the stale watch is on; the helper sends at most one per 100 ms. */
  | { type: 'scroll'; x: number; y: number }
  | { type: 'foregroundApp'; name: string }
  | { type: 'appList'; apps: { name: string; path: string; desc: string }[] }
  | { type: 'error'; message: string; code?: string }
  | { type: 'sim'; swallow: boolean; inject: string };

/** `noAccess`: macOS Accessibility access or a supported Linux X11 session is missing. */
export type HelperStatus = 'starting' | 'running' | 'failed' | 'noAccess';

/** The helper's exit code when OS input is unavailable (macOS permissions / unsupported Linux session). */
export const HELPER_EXIT_NO_ACCESS = 3;

type PointType = 'wheelOpen' | 'wheelMove' | 'wheelRelease' | 'click';
const POINT_TYPES = new Set<string>(['wheelOpen', 'wheelMove', 'wheelRelease', 'click']);
const isInt = (x: unknown): x is number => Number.isInteger(x);
const isWheel = (x: unknown): x is WheelKind => x === 'ping' || x === 'emote' || x === 'ask';

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
    case 'triggerUp':
      return isWheel(o.wheel) ? { type: 'triggerUp', wheel: o.wheel } : null;
    case 'askWords':
    case 'scroll':
      return isInt(o.x) && isInt(o.y) ? { type: o.type, x: o.x, y: o.y } : null;
    case 'foregroundApp':
      return typeof o.name === 'string' ? { type: 'foregroundApp', name: o.name } : null;
    case 'appList': {
      if (!Array.isArray(o.apps)) return null;
      const apps: { name: string; path: string; desc: string }[] = [];
      for (const a of o.apps.slice(0, 64)) {
        const e = typeof a === 'object' && a !== null && !Array.isArray(a) ? a as Record<string, unknown> : null;
        if (e && typeof e.name === 'string' && typeof e.path === 'string') {
          apps.push({ name: e.name, path: e.path, desc: typeof e.desc === 'string' ? e.desc : '' });
        }
      }
      return { type: 'appList', apps };
    }
    case 'error':
      if (typeof o.message !== 'string') return null;
      return typeof o.code === 'string' ? { type: 'error', message: o.message, code: o.code } : { type: 'error', message: o.message };
    case 'sim':
      return typeof o.swallow === 'boolean' && typeof o.inject === 'string'
        ? { type: 'sim', swallow: o.swallow, inject: o.inject }
        : null;
    default:
      if (typeof o.type === 'string' && POINT_TYPES.has(o.type) && isInt(o.x) && isInt(o.y)) {
        // Anything unknown (including no field, from a version 1 helper) is the ping wheel.
        return { type: o.type as PointType, x: o.x, y: o.y, wheel: isWheel(o.wheel) ? o.wheel : 'ping' };
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
      /** 'off': no separate ask key (the teammate is off, or it shares the ping key). */
      askTrigger: HelperTrigger | 'off';
      askTriggerVk: number;
      askClick: boolean;
      /** Tapping the ask key twice opens the words box. Only sent for Alt, Ctrl, Shift and Win. */
      askDoubleTap: boolean;
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
  /** Report scrolls. Its own command, not a config field: a config cancels a gesture the user may be in. */
  | { type: 'staleWatch'; on: boolean }
  | { type: 'getForegroundApp' }
  | { type: 'getAppList' }
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
  // 'same' asks on the ping wheel, so the helper gets no ask key and reports ping gestures as usual.
  const a = featureOn(s, 'teammate') && s.teammate.askTrigger !== 'same' ? s.teammate.askTrigger : 'off';
  // ...and a ping-key click opens the words box, so the helper reports clicks even with click to ping off.
  const sameWords = featureOn(s, 'teammate') && s.teammate.askTrigger === 'same' && s.teammate.askClick;
  const tapKey = s.teammate.askTrigger === 'same' ? s.trigger : s.teammate.askTrigger;
  return {
    type: 'config',
    trigger: typeof t === 'object' ? 'vk' : t,
    triggerVk: typeof t === 'object' ? t.vk : 0,
    clickPing: s.clickPing || sameWords,
    gameCheck: s.gameCheck,
    skipApps: s.skipApps.join(','),
    emoteTrigger: typeof e === 'object' ? 'vk' : e,
    emoteTriggerVk: typeof e === 'object' ? e.vk : 0,
    emoteClick: s.emoteClick && e !== 'off',
    askTrigger: typeof a === 'object' ? 'vk' : a,
    askTriggerVk: typeof a === 'object' ? a.vk : 0,
    askClick: s.teammate.askClick && a !== 'off',
    askDoubleTap: featureOn(s, 'teammate') && s.teammate.askDoubleTap && canDoubleTap(tapKey),
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
