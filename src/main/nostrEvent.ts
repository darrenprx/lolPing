import { createHash } from 'node:crypto';
import { hashes, schnorr } from '@noble/secp256k1';

// noble's synchronous Schnorr needs a SHA-256; Node's is right here.
hashes.sha256 = (msg) => new Uint8Array(createHash('sha256').update(msg).digest());

/** Ephemeral (20000–29999): relays forward these to subscribers and don't store them. */
export const ROOM_EVENT_KIND = 24747;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A throwaway signing key: relays require a signature, the room's own crypto does the real work. */
export interface KeyPair {
  secretKey: Uint8Array;
  /** 64 hex characters, x-only, as NIP-01 wants it. */
  pubkey: string;
}

export type RelayMessage =
  | { type: 'EVENT'; subId: string; event: NostrEvent }
  | { type: 'OK'; eventId: string; ok: boolean; message: string }
  | { type: 'EOSE'; subId: string }
  | { type: 'CLOSED'; subId: string; message: string }
  | { type: 'NOTICE'; message: string };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export function makeKeyPair(): KeyPair {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secretKey, pubkey: toHex(publicKey) };
}

/** NIP-01's canonical form, whose SHA-256 is the event id: [0,pubkey,created_at,kind,tags,content], no spaces. */
export function serializeEvent(pubkey: string, createdAt: number, kind: number, tags: string[][], content: string): string {
  return JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
}

export function signEvent(keys: KeyPair, kind: number, tags: string[][], content: string, createdAt: number): NostrEvent {
  const id = createHash('sha256').update(serializeEvent(keys.pubkey, createdAt, kind, tags, content)).digest();
  return { id: id.toString('hex'), pubkey: keys.pubkey, created_at: createdAt, kind, tags, content, sig: toHex(schnorr.sign(id, keys.secretKey)) };
}

export const reqMessage = (subId: string, topic: string, since: number): string =>
  JSON.stringify(['REQ', subId, { kinds: [ROOM_EVENT_KIND], '#x': [topic], since, limit: 0 }]);
export const eventMessage = (e: NostrEvent): string => JSON.stringify(['EVENT', e]);
export const closeMessage = (subId: string): string => JSON.stringify(['CLOSE', subId]);

const isTags = (t: unknown): t is string[][] =>
  Array.isArray(t) && t.every((tag) => Array.isArray(tag) && tag.every((v) => typeof v === 'string'));

/** A fresh object with exactly the NIP-01 fields, or null. Signatures are left to the relays. */
function toEvent(raw: unknown): NostrEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !HEX64.test(e.id)) return null;
  if (typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey)) return null;
  if (typeof e.sig !== 'string' || !HEX128.test(e.sig)) return null;
  if (!Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0) return null;
  if (!Number.isSafeInteger(e.kind)) return null;
  if (!isTags(e.tags) || typeof e.content !== 'string') return null;
  return {
    id: e.id, pubkey: e.pubkey, created_at: e.created_at as number, kind: e.kind as number,
    tags: e.tags.map((tag) => [...tag]), content: e.content, sig: e.sig,
  };
}

/** One message from a relay, or null for anything malformed or that we don't use (AUTH, COUNT, …). */
export function parseRelayMessage(text: string): RelayMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(m) || typeof m[0] !== 'string') return null;
  const optional = (v: unknown): string | null => (v === undefined ? '' : typeof v === 'string' ? v : null);
  switch (m[0]) {
    case 'EVENT': {
      const event = toEvent(m[2]);
      return typeof m[1] === 'string' && event ? { type: 'EVENT', subId: m[1], event } : null;
    }
    case 'OK': {
      const message = optional(m[3]);
      return typeof m[1] === 'string' && HEX64.test(m[1]) && typeof m[2] === 'boolean' && message !== null
        ? { type: 'OK', eventId: m[1], ok: m[2], message }
        : null;
    }
    case 'EOSE':
      return typeof m[1] === 'string' ? { type: 'EOSE', subId: m[1] } : null;
    case 'CLOSED': {
      const message = optional(m[2]);
      return typeof m[1] === 'string' && message !== null ? { type: 'CLOSED', subId: m[1], message } : null;
    }
    case 'NOTICE':
      return typeof m[1] === 'string' ? { type: 'NOTICE', message: m[1] } : null;
    default:
      return null;
  }
}
