import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, scrypt, sign, verify,
  type KeyObject,
} from 'node:crypto';

/** Every room packet: format byte, nonce, AES-256-GCM ciphertext and tag. Larger packets are never sent or read. */
export const MAX_PACKET = 1200;
/** Format two is exclusively for screenshot attachments; ordinary packets keep their 1200-byte limit. */
export const MAX_SHOT_PACKET = 24_576;
const FORMAT = 0x01;
const NONCE = 12;
const TAG = 16;
const OVERHEAD = 1 + NONCE + TAG;

export interface RoomKeys {
  /** Encrypts every room message. Never leaves the main process. */
  msgKey: Buffer;
  /** The relay topic: 64 hex characters that say nothing without the code. */
  relayTopic: string;
}

/** Room code → keys. scrypt makes guessing a code from a relay topic impractical; HKDF gives each key one job. */
export function deriveRoomKeys(canonical: string): Promise<RoomKeys> {
  return new Promise((resolve, reject) => {
    scrypt(canonical, 'lolping/room/v1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, master) => {
      if (err) return reject(err);
      const sub = (info: string): Buffer => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
      // "sig-room" dates from a WebRTC design; kept so the keys, and the test vectors, stay the same.
      resolve({ msgKey: sub('msg'), relayTopic: sub('sig-room').toString('hex') });
    });
  });
}

export function seal(key: Buffer, plain: Uint8Array): Buffer {
  return sealFormat(key, plain, FORMAT, MAX_PACKET);
}

export function sealShot(key: Buffer, plain: Uint8Array): Buffer {
  return sealFormat(key, plain, 2, MAX_SHOT_PACKET);
}

function sealFormat(key: Buffer, plain: Uint8Array, format: number, limit: number): Buffer {
  if (plain.length + OVERHEAD > limit) throw new Error('room message too large');
  const aad = Buffer.from([format]);
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([aad, nonce, body, cipher.getAuthTag()]);
}

/** The plaintext, or null for anything that isn't a packet sealed with this key. */
export function open(key: Buffer, packet: Uint8Array): Buffer | null {
  return openFormat(key, packet, FORMAT, MAX_PACKET);
}

export function openShot(key: Buffer, packet: Uint8Array): Buffer | null {
  return openFormat(key, packet, 2, MAX_SHOT_PACKET);
}

function openFormat(key: Buffer, packet: Uint8Array, format: number, limit: number): Buffer | null {
  if (packet.length < OVERHEAD || packet.length > limit || packet[0] !== format) return null;
  const buf = Buffer.from(packet.buffer, packet.byteOffset, packet.length);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + NONCE));
    decipher.setAAD(Buffer.from([format]));
    decipher.setAuthTag(buf.subarray(buf.length - TAG));
    return Buffer.concat([decipher.update(buf.subarray(1 + NONCE, buf.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
}

/** A member's signing key for one room session: the raw Ed25519 public key, and the private key that stays here. */
export interface RoomIdentity {
  pk: Buffer;
  key: KeyObject;
}

// DER wrappers that turn a raw 32-byte Ed25519 seed or public key into what node:crypto imports.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The identity grown from a 32-byte seed; the caller passes fresh random bytes, tests a fixed seed. */
export function makeIdentity(seed: Uint8Array): RoomIdentity {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { pk: spki.subarray(SPKI_PREFIX.length), key };
}

/** A member's peer id: the first 16 hex characters of SHA-256 of their public key, so nobody else can claim it. */
export const peerIdOf = (pk: Uint8Array): string => createHash('sha256').update(pk).digest('hex').slice(0, 16);

/** The public key a presence announced, or null when it isn't one. */
export function publicKeyOf(pk: Uint8Array): KeyObject | null {
  if (pk.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** The signature over an encoded message, in base64 (88 characters). */
export const signBody = (id: RoomIdentity, body: Uint8Array): string => sign(null, body, id.key).toString('base64');

export function verifyBody(pk: KeyObject, body: Uint8Array, sig: string): boolean {
  const raw = Buffer.from(sig, 'base64');
  if (raw.length !== 64) return false;
  try {
    return verify(null, body, pk, raw);
  } catch {
    return false;
  }
}
