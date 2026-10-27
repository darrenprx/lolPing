import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes,
  type KeyObject,
} from 'node:crypto';
import { MAX_PACKET } from './roomCrypto';

const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const FORMAT = 2;
const HEADER = 17;
const NONCE = 12;
const TAG = 16;
const PEER = /^[0-9a-f]{16}$/;

export interface DirectIdentity {
  key: KeyObject;
  publicKey: string;
}

/** A fresh X25519 key, announced only inside a signed room presence. */
export function makeDirectIdentity(seed: Uint8Array): DirectIdentity {
  if (seed.length !== 32) throw new Error('invalid direct key seed');
  const key = createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(PUBLIC_PREFIX.length);
  return { key, publicKey: raw.toString('base64') };
}

/** Bind a pairwise key to both signed identities and this room. Invalid/low-order keys are rejected. */
export function directKey(
  identity: DirectIdentity, publicKey: string, roomKey: Uint8Array, self: string, peer: string,
): Buffer | null {
  if (!PEER.test(self) || !PEER.test(peer) || self === peer) return null;
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKey) return null;
  try {
    const remote = createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, raw]), format: 'der', type: 'spki' });
    const secret = diffieHellman({ privateKey: identity.key, publicKey: remote });
    return Buffer.from(hkdfSync('sha256', secret, roomKey, `lolping/direct/v1/${[self, peer].sort().join('/')}`, 32));
  } catch {
    return null;
  }
}

/** The visible routing header contains no message content; it is authenticated as GCM additional data. */
export function directHeader(packet: Uint8Array): { from: string; to: string } | null {
  if (packet[0] !== FORMAT || packet.length < HEADER + NONCE + TAG || packet.length > MAX_PACKET) return null;
  const bytes = Buffer.from(packet);
  return { from: bytes.subarray(1, 9).toString('hex'), to: bytes.subarray(9, HEADER).toString('hex') };
}

export function sealDirect(key: Buffer, from: string, to: string, plain: Uint8Array): Buffer {
  if (!PEER.test(from) || !PEER.test(to) || plain.length + HEADER + NONCE + TAG > MAX_PACKET) {
    throw new Error('invalid direct packet');
  }
  const header = Buffer.concat([Buffer.from([FORMAT]), Buffer.from(from, 'hex'), Buffer.from(to, 'hex')]);
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  return Buffer.concat([header, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function openDirect(key: Buffer, packet: Uint8Array): Buffer | null {
  if (!directHeader(packet)) return null;
  const bytes = Buffer.from(packet);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(HEADER, HEADER + NONCE));
    cipher.setAAD(bytes.subarray(0, HEADER));
    cipher.setAuthTag(bytes.subarray(bytes.length - TAG));
    return Buffer.concat([cipher.update(bytes.subarray(HEADER + NONCE, bytes.length - TAG)), cipher.final()]);
  } catch {
    return null;
  }
}
