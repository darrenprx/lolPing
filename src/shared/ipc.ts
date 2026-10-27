import type { EmoteArt, EmoteFile, EmoteRef, ImportResult, SoundResult } from './emotes';
import type { Lang } from './i18n';
import type { PingId } from './pings';
import type { Platform } from './platform';
import type { HelperStatus, WheelKind } from './protocol';
import type { JoinResult, RoomAudience, RoomState, RoomStateCore } from './room';
import { isTagColor, isTagRgb, type TagRgb } from './roomColors';
import type { HistoryLine } from './roomHistory';
import { PEER_RE } from './roomProtocol';
import type { OverlaySettings, RoomTextStyle, Settings } from './settings';
import type { Rect } from './teammate/coords';
import type { UpdateState } from './update';
import type { VoteView } from './voteTally';

export interface Point {
  x: number;
  y: number;
}

/** The name tag under a room member's ping. `color` indexes TAG_COLORS; `rgb` is a custom colour when set. */
export interface PingTag {
  name: string;
  color: number;
  rgb?: TagRgb | null;
}

/** main → overlay renderer messages. Points are CSS pixels inside that overlay. */
export interface OverlayEvents {
  'overlay:settings': OverlaySettings;
  /** `wheel` names the wheel the gesture belongs to; missing means 'ping' (the site demo leaves it out). */
  'wheel:open': Point & { wheel?: WheelKind };
  'wheel:move': Point & { wheel?: WheelKind };
  'wheel:release': Point & { wheel?: WheelKind };
  'wheel:cancel': null;
  /** `tag` marks a ping from another room member. `keep`: our own ping that stays until 'ping:unkeep' or our next one. */
  'ping:spawn': Point & { id: PingId; tag?: PingTag; keep?: boolean } & MateMark;
  /** Removes the ping kept on this display, if any: we pinged on another display, or paused. */
  'ping:unkeep': null;
  /**
   * `owner` is 'self', 'preview' or a room member: each owner has at most one emote on screen.
   * `keep`: the teammate's emote stays until mate:clear or mate:fade.
   */
  'emote:spawn': Point & { owner: string; art: EmoteArt; tag?: PingTag; ticket?: string; keep?: boolean };
  'emote:clear': { owner: string };
  'toast:show': { title: string; body: string };
  /** `owner` is 'self' or a room member: each owner has at most 3 lines on screen. */
  'text:spawn': Point & { text: string; owner: string; style: RoomTextStyle; tag?: PingTag };
  /** Removes every teammate ping and emote at once. */
  'mate:clear': null;
  /** Fades every teammate ping and emote out, then removes them. */
  'mate:fade': null;
  /** The ask now running: teammate marks stamped with another ticket belong to a cancelled ask and are dropped. */
  'mate:ticket': { id: string };
  /** The teammate said its first line: the dots on its tags stop. */
  'mate:said': null;
  /** A field the teammate just pasted into or filled: an outline over it in the teammate's colour. */
  'mate:glow': MateGlow;
}

/**
 * The outline over a field the teammate wrote. `box` is in CSS px inside the overlay; `color` and `rgb` are the
 * teammate's tag colour; `delay` (ms) lets the fields of one fill light up in order. `ticket` as in MateMark.
 */
export interface MateGlow {
  box: Rect;
  color: number;
  rgb: TagRgb | null;
  delay: number;
  ticket?: string;
}

/** What a teammate ping carries on top of a ping. `ticket` is the ask it answers, set by the overlay manager. */
export interface MateMark {
  owner?: 'mate';
  /** Shown next to the ping, at most 20 characters. */
  label?: string;
  /** Animated dots on the tag until the teammate says something. */
  thinking?: boolean;
  /** No sound: every ping of a set but the first, and the receipt when its sound is off. */
  silent?: boolean;
  /** Only the name tag, no ping art: the receipt for a Do it ask, whose On My Way the user already placed. */
  tagOnly?: boolean;
  ticket?: string;
}

export type OverlayChannel = keyof OverlayEvents;

export const OVERLAY_CHANNELS: readonly OverlayChannel[] = [
  'overlay:settings', 'wheel:open', 'wheel:move', 'wheel:release', 'wheel:cancel', 'ping:spawn', 'ping:unkeep', 'emote:spawn', 'emote:clear',
  'toast:show', 'text:spawn', 'mate:clear', 'mate:fade', 'mate:ticket', 'mate:said', 'mate:glow',
];

/** Larger than any screen in CSS px: a box or a point past these is not one the overlay should draw. */
const GLOW_SIZE_MAX = 32_768;
const GLOW_AT_MAX = 100_000;
/** 60 fields 120 ms apart, with room to spare. */
const GLOW_DELAY_MAX = 10_000;
const TICKET_MAX = 100;

/** The overlay draws a glow only from a message that checks out field by field, whoever sent it. */
export function parseMateGlow(raw: unknown): MateGlow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const g = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const box = g.box as Record<string, unknown> | null | undefined;
  if (typeof box !== 'object' || box === null) return null;
  const { x, y, w, h } = box;
  if (!num(x, -GLOW_AT_MAX, GLOW_AT_MAX) || !num(y, -GLOW_AT_MAX, GLOW_AT_MAX)) return null;
  if (!num(w, 0, GLOW_SIZE_MAX) || !num(h, 0, GLOW_SIZE_MAX) || w === 0 || h === 0) return null;
  if (!isTagColor(g.color) || !num(g.delay, 0, GLOW_DELAY_MAX)) return null;
  const rgb = g.rgb ?? null;
  if (rgb !== null && !isTagRgb(rgb)) return null;
  const { ticket } = g;
  if (ticket !== undefined && (typeof ticket !== 'string' || ticket.length > TICKET_MAX)) return null;
  return { box: { x, y, w, h }, color: g.color, rgb, delay: g.delay, ...(ticket === undefined ? {} : { ticket }) };
}

export const TEXT_CH = { submit: 'text:submit', cancel: 'text:cancel', strings: 'text:strings' } as const;

/** The text box's words, in the language the app uses. */
export interface TextBoxText {
  placeholder: string;
  /** The commands the box understands, shown under the input. */
  hint: string;
  /** Shown instead of the hint when the text was a command that doesn't exist. */
  unknown: string;
  /** Shown instead of the hint for a vote command while votes are switched off. */
  votesOff: string;
}

/** What the app made of a submit: 'sent' closes the box, the others keep it open with a hint. */
export type TextAnswer = 'sent' | 'unknown' | 'votesOff';

export interface TextApi {
  /** Resolves with the app's answer; on 'sent' the window closes. */
  submit(text: string): Promise<TextAnswer>;
  cancel(): void;
  strings(): Promise<TextBoxText | null>;
}

export const PANEL_CH = { state: 'panel:state', action: 'panel:action' } as const;

/** Everything a panel window draws. The roster and the vote widget get the same shape, so one message feeds either. */
export interface PanelState {
  view: 'roster' | 'vote';
  lang: Lang;
  /** The room's member limit. */
  max: number;
  room: RoomStateCore;
  history: readonly HistoryLine[];
  vote: VoteView | null;
  /** The vote's result is in: its widget stays a moment with the buttons off and the countdown stopped. */
  voteOver: boolean;
  /** The room text and room votes feature switches. */
  textOn: boolean;
  votesOn: boolean;
  /** The ping sound volume, 0 to 1 (0 when muted): the ready check's sounds play at it. */
  volume: number;
}

/** What a click in a panel window asks for. An `alive` line is placed at the cursor by the app, not by the page. */
export type PanelAction =
  | { t: 'alive'; peer: string }
  | { t: 'mute'; peer: string; on: boolean }
  | { t: 'kick'; peer: string }
  | { t: 'vote'; kind: 'ff' | 'ready' }
  | { t: 'ballot'; yes: boolean };

export interface PanelApi {
  /** Calls `cb` with every state the main process sends; returns the way to stop. */
  on(cb: (state: PanelState) => void): () => void;
  act(action: PanelAction): void;
}

/** A panel window is only a view: whatever it sends is checked here from `unknown`, field by field. */
export function parsePanelAction(raw: unknown): PanelAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const isPeer = (v: unknown): v is string => typeof v === 'string' && PEER_RE.test(v);
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  switch (a.t) {
    case 'alive':
      return isPeer(a.peer) ? { t: 'alive', peer: a.peer } : null;
    case 'mute':
      return isPeer(a.peer) && typeof a.on === 'boolean' ? { t: 'mute', peer: a.peer, on: a.on } : null;
    case 'kick':
      return isPeer(a.peer) ? { t: 'kick', peer: a.peer } : null;
    case 'vote':
      return a.kind === 'ff' || a.kind === 'ready' ? { t: 'vote', kind: a.kind } : null;
    case 'ballot':
      return typeof a.yes === 'boolean' ? { t: 'ballot', yes: a.yes } : null;
    default:
      return null;
  }
}

/** overlay renderer → main: string[] of asset files that failed to load. */
export const OVERLAY_ASSETS = 'overlay:assets';
/** overlay renderer → main: {id, x, y} of a ping the wheel just placed, so it can be shared with the room. */
export const OVERLAY_PINGED = 'overlay:pinged';
/** overlay renderer → main: {ref, x, y} of an emote the wheel just placed, so it can be shared with the room. */
export const OVERLAY_EMOTED = 'overlay:emoted';
/** overlay renderer → main: true once nothing has been on the overlay for a moment, false when something shows again. */
export const OVERLAY_IDLE = 'overlay:idle';

export interface AppStatus {
  enabled: boolean;
  helper: HelperStatus;
  /**
   * macOS only: lolPing is in the Accessibility list but the helper still can't read input. That is a stale entry
   * left by an update (ad-hoc signatures change every build): it has to be removed and added again.
   */
  staleAccess?: boolean;
}

export interface About {
  version: string;
  problems: string[];
  limitations: string[];
}

export type SetSettingsResult = { ok: true; settings: Settings } | { ok: false; error: string; settings: Settings };

/** Storing a key or Your instructions; 'unavailable': the system can't encrypt them, so nothing was stored. */
export type SecretResult = { ok: boolean; error?: 'unavailable' };
/** Check key lists the provider's models; it never asks for a completion. `message` never contains the key. */
export type CheckKeyResult =
  | { ok: true; models: string[] }
  | { ok: false; error: 'auth' | 'network' | 'other'; message: string };
/** Check on an agent profile: what `<command> --version` printed. `detail` is the command, or the first line of stderr. */
export type CheckAgentResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'notFound' | 'timeout' | 'failed'; detail: string };
/** The tokens the teammate's providers reported this month. */
export interface UsageMonth {
  /** YYYY-MM */
  month: string;
  input: number;
  output: number;
}
export type TeammateHistoryOp = 'open' | 'pause' | 'resume' | 'clear';
/** false: the system can't encrypt, so keys can't be saved and history is off. */
export interface TeammateStatus {
  secretsAvailable: boolean;
  /** macOS only: whether Screen Recording is allowed. null where no such permission exists. */
  screenAccess: boolean | null;
}
export const TEAMMATE_HISTORY_OPS: readonly TeammateHistoryOp[] = ['open', 'pause', 'resume', 'clear'];

// SETTINGS_CH lives in its own module so the settings preload can import it without sharing a chunk
// with the overlay preload (a sandboxed preload can only require('electron'), never a sibling file).
export { SETTINGS_CH } from './settingsChannels';

/** window.settingsApi in the settings renderer. */
export interface SettingsApi {
  readonly platform: Platform;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<SetSettingsResult>;
  onSettings(cb: (s: Settings) => void): () => void;
  getStatus(): Promise<AppStatus>;
  onStatus(cb: (s: AppStatus) => void): () => void;
  setEnabled(on: boolean): Promise<void>;
  previewPing(id: PingId): Promise<void>;
  /** Plays the emote in the middle of the primary display, without sharing it. */
  previewEmote(ref: EmoteRef): Promise<void>;
  /** Saves an image prepared by the settings window and adds it to the imported emotes. */
  importEmote(file: EmoteFile): Promise<ImportResult>;
  /** Deletes an imported emote's files and entry; wheel slots that used it fall back. */
  removeEmote(id: EmoteRef): Promise<void>;
  /** Gives one of our imported emotes a sound (OGG, MP3 or WAV bytes), or takes it away with null. */
  setEmoteSound(id: EmoteRef, sound: Uint8Array | null): Promise<SoundResult>;
  /** Stores which signature effect the emote plays; undefined puts it back to the plain pop. */
  setEmoteFx(id: EmoteRef, fx: number | undefined): Promise<void>;
  getAbout(): Promise<About>;
  openSettingsFolder(): Promise<void>;
  openProjectPage(): Promise<void>;
  retryHelper(): Promise<void>;
  setCapturing(on: boolean): Promise<void>;
  /** macOS: asks for Accessibility access and opens that page of System Settings. */
  openAccessibility(): Promise<void>;
  getRoom(): Promise<RoomState>;
  setRoomAudience(audience: RoomAudience): Promise<void>;
  retryRoomMedia(): Promise<void>;
  setRoomTurnCredential(value: string): Promise<boolean>;
  onRoom(cb: (s: RoomState) => void): () => void;
  createRoom(): Promise<void>;
  /** Accepts a code or any text containing one. */
  joinRoom(text: string): Promise<JoinResult>;
  leaveRoom(): Promise<void>;
  muteMember(peer: string, on: boolean): Promise<void>;
  /** The room code on the clipboard, if there is one. The clipboard is read only when this is called. */
  clipboardRoomCode(): Promise<string | null>;
  copyRoomCode(): Promise<void>;
  /** Reconnects to every relay now (the Room page's Retry). */
  retryInternet(): Promise<void>;
  /** The main process asks to scroll to a section (e.g. tray → Room settings…). */
  onShowSection(cb: (id: string) => void): () => void;
  /** Where the update checker is, or null when this build has none (a development build): then the page shows no update controls. */
  getUpdate(): Promise<UpdateState | null>;
  onUpdate(cb: (s: UpdateState) => void): () => void;
  /** A manual check for a new version. Does nothing while a check, a download or an install is already running. */
  checkForUpdates(): Promise<void>;
  /** Downloads and installs the version that was found. Returns at once; progress arrives through onUpdate. */
  startUpdate(): Promise<void>;
  /** Opens the release notes of the version that was found, or else the page of the latest release. */
  openReleasePage(): Promise<void>;
  /** Stores a profile's key (an empty key removes it). The key is never sent back to this window. */
  setTeammateKey(profileId: string, key: string): Promise<SecretResult>;
  hasTeammateKey(profileId: string): Promise<boolean>;
  checkTeammateKey(profileId: string): Promise<CheckKeyResult>;
  /** Runs an agent profile's command with --version. The main process looks the profile up; no command comes from here. */
  checkTeammateAgent(profileId: string): Promise<CheckAgentResult>;
  /** Shows the system folder picker; the chosen path, or null when it was cancelled. */
  pickTeammateFolder(): Promise<string | null>;
  /**
   * What the agent profile's agent needs to add lolPing: the JSON for its MCP file, or its `mcp add` line; null for
   * an unknown or custom profile, or when it can't be made.
   */
  getTeammateAgentSnippet(profileId: string): Promise<{ text: string } | null>;
  /** The text to paste into the app with this CONNECT_APPS id (its config or command line); null for an unknown app. */
  getTeammateConnectSnippet(appId: string): Promise<{ text: string } | null>;
  /** Foreground app names of this session's asks, newest first: the App field of a rule offers them. */
  getTeammateRecentApps(): Promise<string[]>;
  /** The editors found on this computer, named as the helper names the foreground app. */
  getTeammateEditors(): Promise<string[]>;
  setTeammateInstructions(text: string): Promise<SecretResult>;
  /** Your instructions: the user's own text, so this window may read it back. */
  getTeammateInstructions(): Promise<string>;
  getTeammateUsage(): Promise<UsageMonth>;
  /** Resolves true when it was carried out (Clear can fail). */
  teammateHistory(op: TeammateHistoryOp): Promise<boolean>;
  getTeammateStatus(): Promise<TeammateStatus>;
  /** macOS: asks for Screen Recording access and opens that page of System Settings. */
  openScreenRecording(): Promise<void>;
}
