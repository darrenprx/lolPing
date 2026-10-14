import type { EmoteArt, EmoteFile, EmoteRef, ImportResult } from './emotes';
import type { PingId } from './pings';
import type { Platform } from './platform';
import type { HelperStatus, WheelKind } from './protocol';
import type { JoinResult, RoomState } from './room';
import type { OverlaySettings, Settings } from './settings';
import type { UpdateState } from './update';

export interface Point {
  x: number;
  y: number;
}

/** The name tag under a room member's ping. `color` indexes TAG_COLORS. */
export interface PingTag {
  name: string;
  color: number;
}

/** main → overlay renderer messages. Points are CSS pixels inside that overlay. */
export interface OverlayEvents {
  'overlay:settings': OverlaySettings;
  /** `wheel` names the wheel the gesture belongs to; missing means 'ping' (the site demo leaves it out). */
  'wheel:open': Point & { wheel?: WheelKind };
  'wheel:move': Point & { wheel?: WheelKind };
  'wheel:release': Point & { wheel?: WheelKind };
  'wheel:cancel': null;
  /** `tag` marks a ping from another room member. */
  'ping:spawn': Point & { id: PingId; tag?: PingTag };
  /** `owner` is 'self', 'preview' or a room member: each owner has at most one emote on screen. */
  'emote:spawn': Point & { owner: string; art: EmoteArt; tag?: PingTag };
  'emote:clear': { owner: string };
  'toast:show': { title: string; body: string };
}

export type OverlayChannel = keyof OverlayEvents;

export const OVERLAY_CHANNELS: readonly OverlayChannel[] = [
  'overlay:settings', 'wheel:open', 'wheel:move', 'wheel:release', 'wheel:cancel', 'ping:spawn', 'emote:spawn', 'emote:clear',
  'toast:show',
];

/** overlay renderer → main: string[] of asset files that failed to load. */
export const OVERLAY_ASSETS = 'overlay:assets';
/** overlay renderer → main: {id, x, y} of a ping the wheel just placed, so it can be shared with the room. */
export const OVERLAY_PINGED = 'overlay:pinged';
/** overlay renderer → main: {ref, x, y} of an emote the wheel just placed, so it can be shared with the room. */
export const OVERLAY_EMOTED = 'overlay:emoted';

/** The selected area in CSS px inside the capture window's display. */
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** main → capture renderer messages. */
export interface CaptureEvents {
  /** The window covers its display and takes the mouse; the strings are one-line texts in the app language. */
  'capture:begin': { hint: string; confirm: string; cancel: string };
}

export const CAPTURE_CHANNELS: readonly (keyof CaptureEvents)[] = ['capture:begin'];

/** capture renderer → main: {rect} the user confirmed (a click's fullscreen area included). */
export const CAPTURE_CONFIRM = 'capture:confirm';
/** capture renderer → main: the user dismissed the capture. */
export const CAPTURE_CANCEL = 'capture:cancel';

/** One round of the conversation: what was asked and what the model answered. */
export interface AnswerTurn {
  /** The user's question; the first round quotes the one-line prompt the shot was sent with. */
  q: string;
  /** The model's answer, or the error text; empty while this round is pending. */
  a: string;
  /** This round's answer is still being fetched. */
  pending: boolean;
  /** The answer is an error, drawn apart from a normal answer. */
  error: boolean;
}

/** main → answer renderer messages. A full snapshot every time: the page just re-renders it. */
export interface AnswerEvents {
  'answer:state': {
    mode: 'fullscreen' | 'card';
    title: string;
    /** The captured shot as a data URL, for the thumbnail; empty when hidden or unavailable. */
    thumbnail: string;
    /** The conversation so far, oldest first. */
    turns: AnswerTurn[];
    /** The input's placeholder, in the app language. */
    askPlaceholder: string;
    /** Answer text size, in CSS px. */
    fontSize: number;
    closeHint: string;
    /** Card mode only: seconds until the page closes itself. */
    cardSeconds: number;
  };
}

export const ANSWER_CHANNELS: readonly (keyof AnswerEvents)[] = ['answer:state'];

/** The full payload the answer page renders from. */
export type AnswerState = AnswerEvents['answer:state'];

/** answer renderer → main: the user asked a follow-up with this text. */
export const ANSWER_ASK = 'answer:ask';
/** answer renderer → main: the user closed the answer (Esc, or the card's ✕ / timer). */
export const ANSWER_CLOSE = 'answer:close';

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

/** The AI test button's outcome: the model's answer, or the sorted failure reason with the service's own text. */
export type AiTestResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'noKey' | 'network' | 'auth' | 'model' | 'busy' | 'response' | 'timeout' | 'unknown'; detail: string };

/** The AI service fields as the settings window has them, before they are saved. */
export interface AiTestConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

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
  getAbout(): Promise<About>;
  openSettingsFolder(): Promise<void>;
  openProjectPage(): Promise<void>;
  retryHelper(): Promise<void>;
  setCapturing(on: boolean): Promise<void>;
  /** macOS: asks for Accessibility access and opens that page of System Settings. */
  openAccessibility(): Promise<void>;
  getRoom(): Promise<RoomState>;
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
  /** Tries a one-pixel image against the AI service in these fields, so the page can say whether they work. */
  testAi(cfg: AiTestConfig): Promise<AiTestResult>;
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
}
