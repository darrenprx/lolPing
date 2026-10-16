import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG, type CatalogEmote } from './emoteCatalog';
import type { Lang } from './i18n';

/** A bundled emote's slug, or 'c:' + 32 lower-case hex characters (the hash of an imported emote). */
export type EmoteRef = string;

export interface CustomEmote {
  id: EmoteRef;
  name: string;
  /** Has a `.anim` file besides the still. */
  animated: boolean;
  /** Has a `.sound` file: it plays when we place the emote, on this computer only (rooms never get it). */
  sound?: boolean;
  /** Which signature effect it plays when it lands: 0–5. Nothing stored (an entry from an older version) plays the plain pop. */
  fx?: number;
}

/** A stored effect: an integer within EMOTE_FX_VARIANTS. Anything else means the plain pop. */
export const isEmoteFx = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < EMOTE_FX_VARIANTS;

/** What an emote looks like on screen. A placeholder stands in for a custom emote whose files are missing. */
export type EmoteArt =
  | { kind: 'bundled'; slug: string }
  | { kind: 'custom'; url: string; animated: boolean; sound?: string; /** The signature effect it plays; 0 is the plain pop. */ fx: number }
  | { kind: 'placeholder' };

export type ImportError = 'type' | 'size' | 'animSize' | 'detail' | 'full' | 'duplicate' | 'disk';
/** What the settings renderer sends the main process when importing: the 160 px still and, optionally, the original animation. */
export interface EmoteFile {
  name: string;
  still: Uint8Array;
  anim?: Uint8Array;
}
export type ImportResult = { ok: true; id: EmoteRef } | { ok: false; error: ImportError };
export type SoundError = 'type' | 'size' | 'long' | 'disk';
export type SoundResult = { ok: true } | { ok: false; error: SoundError };

export const MAX_CUSTOM_EMOTES = 24;
export const EMOTE_DURATION_S = 3;
/** The shortest time a custom animation plays: the plain envelope's entrance and goodbye, back to back. */
export const EMOTE_ANIM_MIN_S = 0.6;
/**
 * How long an emote whose animation loops in `loopMs` stays up: one loop of it, but never shorter than an effect needs to
 * be readable and never past the default. Nothing measurable (a still, damaged data) keeps the default.
 */
export const emoteDurationS = (loopMs: number | null): number =>
  loopMs === null ? EMOTE_DURATION_S : Math.min(Math.max(loopMs / 1000, EMOTE_ANIM_MIN_S), EMOTE_DURATION_S);
export const CUSTOM_NAME_MAX = 24;
export const STILL_MAX_BYTES = 12_288;
export const STILL_SIDE = 160;
export const STILL_FALLBACK_SIDE = 128;
export const INPUT_MAX_BYTES = 8_388_608;
/** The longest side of a picked image the settings window will decode: a small file can declare billions of pixels. */
export const INPUT_MAX_SIDE = 8192;
export const ANIM_MAX_BYTES = 5_242_880;
export const ANIM_MAX_SIDE = 1024;
/** An imported emote's sound: OGG, MP3 or WAV, at most this many bytes and seconds. */
export const SOUND_MAX_BYTES = 1_048_576;
export const SOUND_MAX_S = 5;
/**
 * The signature effects a custom emote can play when it lands: 0 is the plain pop, then spin-in, bounce drop, flash
 * focus, pendulum swing and heartbeat. Which one an image plays is stored on its entry (`CustomEmote.fx`, picked by
 * right-clicking it in the settings window); nothing stored plays the plain pop.
 */
export const EMOTE_FX_VARIANTS = 6;

const SLUG = /^[a-z0-9_]{1,40}$/;
const CUSTOM = /^c:[0-9a-f]{32}$/;

/** Well-formed, whether or not it exists. Room messages are checked against this before anything looks it up. */
export const isEmoteRefShape = (v: unknown): v is EmoteRef => typeof v === 'string' && (SLUG.test(v) || CUSTOM.test(v));
export const isCustomRef = (v: unknown): v is EmoteRef => typeof v === 'string' && CUSTOM.test(v);
/** The 32 lower-case hex characters a custom emote hash must be. */
export const HASH_RE = /^[0-9a-f]{32}$/;
/** The most hashes one presence announces: the wheel plus the centre, minus duplicates. */
export const ANNOUNCED_MAX = 9;

const BY_SLUG: ReadonlyMap<string, CatalogEmote> = new Map(EMOTE_CATALOG.map((e) => [e.slug, e]));

export const catalogEmote = (slug: string): CatalogEmote | undefined => BY_SLUG.get(slug);
export const isBundledEmote = (v: unknown): v is EmoteRef => typeof v === 'string' && BY_SLUG.has(v);
export const customHash = (ref: EmoteRef): string => ref.slice(2);

/** Relative to a renderer page at <root>/<page>/index.html; assets/ is served at <root>/. */
export const emoteAnimUrl = (slug: string): string => `../emotes/${slug}.webp`;
export const emoteIconUrl = (slug: string): string => `../emotes/${slug}.png`;
export const emoteSoundUrl = (slug: string): string => `../emotes/${slug}.ogg`;
/** Imported emotes live in the user's data folder; the lolping:// protocol serves them under this. */
export const CUSTOM_EMOTE_URL = 'lolping://emotes/';
export const customStillUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.webp`;
export const customAnimUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.anim`;
export const customSoundUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.sound`;

/** Every bundled file that has to ship, relative to assets/. */
export function allEmoteAssetFiles(): string[] {
  return EMOTE_CATALOG.flatMap((e) => [`emotes/${e.slug}.webp`, `emotes/${e.slug}.png`, ...(e.hasSound ? [`emotes/${e.slug}.ogg`] : [])]);
}

export function emoteName(ref: EmoteRef, lang: Lang, custom: readonly CustomEmote[]): string {
  const bundled = catalogEmote(ref);
  if (bundled) return lang === 'zh-CN' ? bundled.nameZh : bundled.name;
  return custom.find((c) => c.id === ref)?.name ?? '?';
}

/** The hashes one presence announces: the custom emotes on the centre and wheel, distinct, at most ANNOUNCED_MAX. */
export function announcedEmoteHashes(wheel: readonly EmoteRef[], centre: EmoteRef): string[] {
  const out: string[] = [];
  for (const ref of [centre, ...wheel]) {
    if (!isCustomRef(ref)) continue;
    const hash = customHash(ref);
    if (!out.includes(hash)) out.push(hash);
    if (out.length >= ANNOUNCED_MAX) break;
  }
  return out;
}

const isKnown = (ref: EmoteRef, custom: readonly CustomEmote[]): boolean =>
  isBundledEmote(ref) || (isCustomRef(ref) && custom.some((c) => c.id === ref));

/**
 * A wheel is 8 distinct, well-formed refs. Anything else gives the default wheel. A slot whose emote no longer exists
 * gets that slot's default, or, when the wheel already holds it, the first catalog emote that isn't on the wheel.
 */
export function normalizeEmoteWheel(raw: unknown, custom: readonly CustomEmote[]): EmoteRef[] {
  const slots = DEFAULT_EMOTE_WHEEL.length;
  if (!Array.isArray(raw) || raw.length !== slots || !raw.every(isEmoteRefShape) || new Set(raw).size !== slots) {
    return [...DEFAULT_EMOTE_WHEEL];
  }
  const wheel: EmoteRef[] = [...raw];
  const used = new Set(wheel.filter((ref) => isKnown(ref, custom)));
  for (let i = 0; i < slots; i++) {
    if (isKnown(wheel[i], custom)) continue;
    const pick = used.has(DEFAULT_EMOTE_WHEEL[i]) ? EMOTE_CATALOG.find((e) => !used.has(e.slug))!.slug : DEFAULT_EMOTE_WHEEL[i];
    used.add(pick);
    wheel[i] = pick;
  }
  return wheel;
}

export function normalizeClickEmote(raw: unknown, custom: readonly CustomEmote[]): EmoteRef {
  return isEmoteRefShape(raw) && isKnown(raw, custom) ? raw : DEFAULT_CLICK_EMOTE;
}
