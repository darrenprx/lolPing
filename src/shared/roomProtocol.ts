import { ANIM_MAX_BYTES, ANNOUNCED_MAX, HASH_RE, isEmoteFx, isEmoteRefShape, type EmoteRef } from './emotes';
import { isPingId, type PingId } from './pings';
import { isTagColor, isTagRgb, type TagRgb } from './roomColors';

/** Bumped when room messages change incompatibly. Peers on another version are shown as "needs update". */
export const PROTOCOL_VERSION = 1;
export const MAX_NAME = 16;
/** The first app version that sends and shows room text, alive lines and votes. */
export const ROOM_CHAT_SINCE = '0.5.2';
export const MAX_TEXT = 120;
const MAX_DISPLAY = 16;
const MAX_APP_VERSION = 64;

/** Room features a member can switch off; their presence says so, so nobody sends them what they can't show. */
export type RoomFeatureOff = 'text' | 'votes';
const FEATURES_OFF: readonly RoomFeatureOff[] = ['text', 'votes'];

export type MemberStatus = 'on' | 'paused' | 'muted';
const STATUSES: readonly MemberStatus[] = ['on', 'paused', 'muted'];

interface Base {
  /** Random per launch, 16 lower-case hex characters. */
  peer: string;
  /** +1 for every message the peer sends. */
  seq: number;
  /** Sender's clock, ms since epoch. */
  ts: number;
}
export interface PresenceMsg extends Base {
  t: 'presence';
  proto: number;
  app: string;
  name: string;
  color: number;
  /** A custom tag colour, three 0–255 channels. Optional: a peer on an older build sends none, and ignores ours. */
  rgb?: TagRgb;
  status: MemberStatus;
  /** Added in 0.5.2: the 32-hex hashes of the custom emotes on our wheel and centre, at most 9. Older apps leave it out. */
  em: string[];
  /** Added in 0.5.2: the room features this peer has switched off. Older apps leave it out, which reads as none. */
  nf: RoomFeatureOff[];
  /** Added in 0.5.2: the Ed25519 public key, raw, in base64. The peer id is its hash, and every message but a chunk is signed with it. */
  pk?: string;
  /** Optional LAN animation transfer capability; absent on older apps. */
  ea?: 1;
}
export interface PingMsg extends Base {
  t: 'ping';
  ping: PingId;
  /** Display number: 1 = primary. */
  d: number;
  /** Position as a fraction of that display, 0–1. */
  x: number;
  y: number;
}
/** Added in 0.5.0: older apps drop it as an unknown type. Position as in PingMsg. */
export interface EmoteMsg extends Base {
  t: 'emote';
  /** A bundled slug (possibly one only a newer app has) or 'c:' + hash of an imported emote. */
  e: EmoteRef;
  /** The sender's chosen effect for a custom emote, 0–5; absent is the plain pop. Added in 0.5.2; older apps leave it out. */
  fx?: number;
  d: number;
  x: number;
  y: number;
}
/** Added after 0.5.1: older apps safely drop it as an unknown type. */
export interface TextMsg extends Base {
  t: 'text';
  text: string;
  d: number;
  x: number;
  y: number;
}
/** Added in 0.5.2: a line from the peer `who` to where the sender's cursor is; older apps drop it as an unknown type. */
export interface AliveMsg extends Base {
  t: 'alive';
  who: string;
  d: number;
  x: number;
  y: number;
}
export type VoteKind = 'ff' | 'ready' | 'kick';
const VOTE_KINDS: readonly VoteKind[] = ['ff', 'ready', 'kick'];
/** Added in 0.5.2: starts a vote. `id` names it; `target` is the peer to remove and only a kick has one. */
export interface VoteMsg extends Base {
  t: 'vote';
  id: string;
  kind: VoteKind;
  target?: string;
}
/** Added in 0.5.2: the sender's answer to vote `id`. */
export interface BallotMsg extends Base {
  t: 'ballot';
  id: string;
  yes: boolean;
}
/** Added in 0.5.2: asks the peer named `to` for the still of custom emote `h`. `need` lists chunk indexes, [] = all of them. */
export interface WantMsg extends Base {
  t: 'want';
  to: string;
  h: string;
  need: number[];
}
/** Added in 0.5.2: one slice `i` of `n` of the still `h`, base64 in `b`. A chunk's sealed packet stays under MAX_PACKET. */
export interface ChunkMsg extends Base {
  t: 'chunk';
  h: string;
  i: number;
  n: number;
  b: string;
}
export interface ByeMsg extends Base {
  t: 'bye';
}
export interface AnimationInfo {
  /** Full SHA-256 of the animation, independent of the still's emote ID. */
  a: string;
  size: number;
  format: 'gif' | 'webp';
}
/** No `a` asks for metadata; otherwise `need` requests one bounded window of chunks. */
export interface AnimationWantMsg extends Base {
  t: 'anim-want';
  to: string;
  h: string;
  a?: string;
  need?: number[];
}
/** Signed binding between this member's still and its original animation. */
export interface AnimationInfoMsg extends Base {
  t: 'anim-info';
  to: string;
  h: string;
  info: AnimationInfo | null;
}
export interface AnimationChunkMsg extends Base {
  t: 'anim-chunk';
  to: string;
  h: string;
  a: string;
  i: number;
  b: string;
}
export type AnimationMessage = AnimationWantMsg | AnimationInfoMsg | AnimationChunkMsg;
export type RoomMessage = PresenceMsg | PingMsg | EmoteMsg | TextMsg | AliveMsg | VoteMsg | BallotMsg | WantMsg | ChunkMsg | ByeMsg | AnimationMessage;

/** Signed animation packets retain room for worst-case sequence numbers under MAX_PACKET. */
export const ANIMATION_CHUNK_BYTES = 540;
export const ANIMATION_WINDOW = 32;
export const ANIMATION_CHUNKS_MAX = Math.ceil(ANIM_MAX_BYTES / ANIMATION_CHUNK_BYTES);
export const ANIMATION_HASH_RE = /^[0-9a-f]{64}$/;

// C0/C1 controls, zero-width characters, bidi marks, embeddings and isolates, BOM, line/paragraph separators,
// soft hyphen, combining grapheme joiner, Arabic letter mark, Mongolian vowel separator and the Hangul fillers
// (blank characters that would make a name invisible).
const UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\ufeff\uffa0]/g;

/** While typing: at most MAX_NAME code points (an emoji counts once; maxLength would count UTF-16 units). */
export const clampNameInput = (v: string): string => [...v].slice(0, MAX_NAME).join('');

/** A display name that can't hide, reorder or break the text around it. `max` is in code points. */
export function sanitizeName(raw: string, fallback = 'Player', max = MAX_NAME): string {
  const name = [...raw.replace(UNSAFE_CHARS, '').trim()].slice(0, max).join('').trim();
  return name || fallback;
}

/** Plain overlay text that cannot hide, reorder, or break the UI around it. */
export function sanitizeText(raw: string): string {
  return [...raw.replace(UNSAFE_CHARS, '').trim()].slice(0, MAX_TEXT).join('').trim();
}

/** A peer id: 16 lowercase hex digits. */
export const PEER_RE = /^[0-9a-f]{16}$/;
const VOTE_ID_RE = /^[0-9a-f]{8}$/;
/** A vote id: 8 lower-case hex characters. */
export const isVoteId = (v: unknown): v is string => typeof v === 'string' && VOTE_ID_RE.test(v);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

/** Chunk `b` is at most this many base64 characters (750 bytes); 17 chunks carry a full 12 KB still. */
export const EMOTE_CHUNK_B64_MAX = 1000;
export const EMOTE_CHUNKS_MAX = 17;
/** Chunk indexes in a `want`'s `need`: at most this many entries, each below EMOTE_CHUNKS_MAX. */
export const EMOTE_NEED_MAX = 64;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** 32 raw bytes in base64. */
const PK_RE = /^[A-Za-z0-9+/]{43}=$/;
/** The signature tail: 64 raw bytes in base64, as the last field, so a receiver can cut it off and get the signed bytes. */
const SIG_TAIL_RE = /,"sg":"([A-Za-z0-9+/]{86}==)"}$/;

/** The announced hashes, rebuilt: well-formed and distinct, the first ANNOUNCED_MAX. Anything else means none. */
function emList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !HASH_RE.test(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= ANNOUNCED_MAX) break;
  }
  return out;
}

/** The switched-off features, rebuilt: known ones only, once each. Anything else means none. */
function nfList(raw: unknown): RoomFeatureOff[] {
  if (!Array.isArray(raw)) return [];
  return FEATURES_OFF.filter((f) => raw.includes(f));
}

/** Builds a fresh message from known fields only, or null when anything is missing or out of range. */
export function validateMessage(raw: unknown): RoomMessage | null {
  if (!isObj(raw)) return null;
  const { t, peer, seq, ts } = raw;
  if (typeof peer !== 'string' || !/^[0-9a-f]{16}$/.test(peer) || !isUint(seq) || !isUint(ts)) return null;
  const base = { peer, seq, ts };
  switch (t) {
    case 'presence': {
      const { proto, app, name, color, rgb, status, em, nf, pk } = raw;
      if (!isUint(proto) || typeof app !== 'string' || app.length > MAX_APP_VERSION || typeof name !== 'string') return null;
      if (!isTagColor(color) || !STATUSES.includes(status as MemberStatus)) return null;
      const presence: PresenceMsg = {
        t, ...base, proto, app, name: sanitizeName(name.slice(0, 256)), color, status: status as MemberStatus,
        em: emList(em), nf: nfList(nf), ...(typeof pk === 'string' && PK_RE.test(pk) ? { pk } : {}),
        ...(raw.ea === 1 ? { ea: 1 as const } : {}),
      };
      // A malformed custom colour is dropped rather than the whole presence: an unreadable tag beats a missing member.
      return isTagRgb(rgb) ? { ...presence, rgb } : presence;
    }
    case 'ping': {
      const { ping, d, x, y } = raw;
      if (!isPingId(ping) || !Number.isInteger(d) || (d as number) < 1 || (d as number) > MAX_DISPLAY) return null;
      if (!isUnit(x) || !isUnit(y)) return null;
      return { t, ...base, ping, d: d as number, x, y };
    }
    case 'emote': {
      const { e, fx, d, x, y } = raw;
      if (!isEmoteRefShape(e) || !Number.isInteger(d) || (d as number) < 1 || (d as number) > MAX_DISPLAY) return null;
      if (!isUnit(x) || !isUnit(y)) return null;
      // A malformed effect is dropped rather than the whole emote, the way a malformed tag colour is: the sender's
      // moment still plays, as the plain pop.
      return { t, ...base, e, d: d as number, x, y, ...(isEmoteFx(fx) ? { fx } : {}) };
    }
    case 'text': {
      const { text, d, x, y } = raw;
      if (typeof text !== 'string' || !Number.isInteger(d) || (d as number) < 1 || (d as number) > MAX_DISPLAY) return null;
      if (!isUnit(x) || !isUnit(y)) return null;
      const safe = sanitizeText(text);
      return safe ? { t, ...base, text: safe, d: d as number, x, y } : null;
    }
    case 'alive': {
      const { who, d, x, y } = raw;
      if (typeof who !== 'string' || !PEER_RE.test(who)) return null;
      if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > MAX_DISPLAY || !isUnit(x) || !isUnit(y)) return null;
      return { t, ...base, who, d: d as number, x, y };
    }
    case 'vote': {
      const { id, kind, target } = raw;
      if (!isVoteId(id) || !VOTE_KINDS.includes(kind as VoteKind)) return null;
      if (kind === 'kick') {
        return typeof target === 'string' && PEER_RE.test(target) ? { t, ...base, id, kind, target } : null;
      }
      return target === undefined ? { t, ...base, id, kind: kind as VoteKind } : null;
    }
    case 'ballot': {
      const { id, yes } = raw;
      return isVoteId(id) && typeof yes === 'boolean' ? { t, ...base, id, yes } : null;
    }
    case 'want': {
      const { to, h, need } = raw;
      if (typeof to !== 'string' || !/^[0-9a-f]{16}$/.test(to) || typeof h !== 'string' || !HASH_RE.test(h)) return null;
      if (!Array.isArray(need) || need.length > EMOTE_NEED_MAX) return null;
      if (!need.every((v) => isUint(v) && (v as number) < EMOTE_CHUNKS_MAX)) return null;
      return { t, ...base, to, h, need: [...new Set(need)] };
    }
    case 'chunk': {
      const { h, i, n, b } = raw;
      if (typeof h !== 'string' || !HASH_RE.test(h)) return null;
      if (!isUint(n) || (n as number) < 1 || (n as number) > EMOTE_CHUNKS_MAX) return null;
      if (!isUint(i) || (i as number) >= (n as number)) return null;
      if (typeof b !== 'string' || b.length > EMOTE_CHUNK_B64_MAX || b.length % 4 !== 0 || !B64_RE.test(b)) return null;
      return { t, ...base, h, i: i as number, n: n as number, b };
    }
    case 'anim-want':
    case 'anim-info':
    case 'anim-chunk': {
      const { to, h, a, need, info, i, b } = raw;
      if (typeof to !== 'string' || !PEER_RE.test(to) || typeof h !== 'string' || !HASH_RE.test(h)) return null;
      const addressed = { ...base, to, h };
      if (t === 'anim-info') {
        if (info === null) return { t, ...addressed, info: null };
        if (!isObj(info) || typeof info.a !== 'string' || !ANIMATION_HASH_RE.test(info.a)) return null;
        if (!isUint(info.size) || info.size < 1 || info.size > ANIM_MAX_BYTES) return null;
        if (info.format !== 'gif' && info.format !== 'webp') return null;
        return { t, ...addressed, info: { a: info.a, size: info.size, format: info.format } };
      }
      if (t === 'anim-want' && a === undefined && need === undefined) return { t, ...addressed };
      if (typeof a !== 'string' || !ANIMATION_HASH_RE.test(a)) return null;
      if (t === 'anim-want') {
        if (!Array.isArray(need) || need.length < 1 || need.length > ANIMATION_WINDOW) return null;
        if (!need.every((v) => isUint(v) && v < ANIMATION_CHUNKS_MAX)) return null;
        return { t, ...addressed, a, need: [...new Set(need)] };
      }
      if (!isUint(i) || i >= ANIMATION_CHUNKS_MAX) return null;
      if (typeof b !== 'string' || b.length > ANIMATION_CHUNK_BYTES / 3 * 4 || b.length % 4 !== 0 || !B64_RE.test(b)) return null;
      return { t, ...addressed, a, i, b };
    }
    case 'bye':
      return { t, ...base };
    default:
      return null;
  }
}

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** True only when `app` is a plain x.y.z version lower than `version`: anything else (a dev tool, a prerelease) isn't called old. */
export function isOlderThan(app: string, version: string): boolean {
  const a = PLAIN_VERSION.exec(app);
  const v = PLAIN_VERSION.exec(version);
  if (!a || !v) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(v[i]);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

export function encodeMessage(m: RoomMessage): Uint8Array {
  const out = m.t === 'ping' || m.t === 'emote' || m.t === 'text' || m.t === 'alive' ? { ...m, x: round4(m.x), y: round4(m.y) } : m;
  return new TextEncoder().encode(JSON.stringify(out));
}

/** `body` (an encoded message) with the signature `sig` as its last field. */
export const joinSigned = (body: string, sig: string): string => `${body.slice(0, -1)},"sg":"${sig}"}`;

/** The signed body and its signature, or null when the plaintext carries no well-formed signature tail. */
export function splitSigned(plain: string): { body: string; sig: string } | null {
  const m = SIG_TAIL_RE.exec(plain);
  return m ? { body: `${plain.slice(0, m.index)}}`, sig: m[1] } : null;
}

/** A packet's message, the bytes its signature covers (all of them when unsigned) and the signature, or null. */
export function decodeSigned(plain: Uint8Array): { msg: RoomMessage; body: Uint8Array; sig: string | null } | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return null;
  }
  const signed = splitSigned(text);
  const body = signed ? new TextEncoder().encode(signed.body) : plain;
  const msg = decodeMessage(body);
  return msg ? { msg, body, sig: signed?.sig ?? null } : null;
}

export function decodeMessage(bytes: Uint8Array): RoomMessage | null {
  try {
    return validateMessage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}
