import { describe, expect, it } from 'vitest';
import { directHeader, directKey, makeDirectIdentity, openDirect, sealDirect } from '../../src/main/directRoomCrypto';
import { open } from '../../src/main/roomCrypto';

const A = 'a'.repeat(16);
const B = 'b'.repeat(16);
const C = 'c'.repeat(16);
const room = Buffer.alloc(32, 9);

describe('directRoomCrypto', () => {
  it('lets only the selected pair decrypt even when a third member knows the room key', () => {
    const a = makeDirectIdentity(Buffer.alloc(32, 1));
    const b = makeDirectIdentity(Buffer.alloc(32, 2));
    const c = makeDirectIdentity(Buffer.alloc(32, 3));
    const ab = directKey(a, b.publicKey, room, A, B);
    const ba = directKey(b, a.publicKey, room, B, A);
    const ca = directKey(c, a.publicKey, room, C, A);
    expect(ab).toBeTruthy();
    expect(ba).toEqual(ab);
    if (!ab || !ba || !ca) throw new Error('key derivation failed');
    const text = Buffer.from('private ping');
    const packet = sealDirect(ab, A, B, text);
    expect(directHeader(packet)).toEqual({ from: A, to: B });
    expect(openDirect(ba, packet)).toEqual(text);
    expect(openDirect(ca, packet)).toBeNull();
    expect(open(room, packet)).toBeNull();
    expect(directKey(a, b.publicKey, Buffer.alloc(32, 10), A, B)).not.toEqual(ab);
  });

  it('rejects tampered recipients, ciphertext, invalid keys and oversized packets', () => {
    const a = makeDirectIdentity(Buffer.alloc(32, 1));
    const b = makeDirectIdentity(Buffer.alloc(32, 2));
    const key = directKey(a, b.publicKey, room, A, B);
    if (!key) throw new Error('key derivation failed');
    const packet = sealDirect(key, A, B, Buffer.from('hello'));
    for (const index of [0, 2, 10, 22, packet.length - 1]) {
      const tampered = Buffer.from(packet);
      tampered[index] ^= 1;
      expect(openDirect(key, tampered)).toBeNull();
    }
    expect(directKey(a, Buffer.alloc(32).toString('base64'), room, A, B)).toBeNull();
    expect(directKey(a, 'bad', room, A, B)).toBeNull();
    expect(directKey(a, b.publicKey, room, A, A)).toBeNull();
    expect(() => sealDirect(key, A, B, Buffer.alloc(1156))).toThrow();
    expect(sealDirect(key, A, B, Buffer.alloc(1155))).toHaveLength(1200);
    expect(directHeader(Buffer.alloc(1201, 2))).toBeNull();
  });
});
