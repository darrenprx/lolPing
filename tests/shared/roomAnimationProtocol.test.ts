import { describe, expect, it } from 'vitest';
import { makeIdentity, MAX_PACKET, open, seal, signBody } from '../../src/main/roomCrypto';
import { ANIM_MAX_BYTES } from '../../src/shared/emotes';
import {
  ANIMATION_CHUNK_BYTES, ANIMATION_CHUNKS_MAX, ANIMATION_WINDOW, decodeSigned, encodeMessage, joinSigned,
  validateMessage, type RoomMessage,
} from '../../src/shared/roomProtocol';

const base = { peer: 'a'.repeat(16), seq: Number.MAX_SAFE_INTEGER, ts: Number.MAX_SAFE_INTEGER };
const addressed = { ...base, to: 'b'.repeat(16), h: 'c'.repeat(32) };
const info = { a: 'd'.repeat(64), size: ANIM_MAX_BYTES, format: 'gif' };
const want = { ...addressed, t: 'anim-want', a: info.a, need: [0, 1, ANIMATION_CHUNKS_MAX - 1] };

describe('roomProtocol animation extension', () => {
  it('leaves old presences unchanged and treats a malformed capability as absent', () => {
    const old = { ...base, t: 'presence', proto: 1, app: '0.5.3', name: 'Alex', color: 3, status: 'on', em: [], nf: [] };
    expect(validateMessage(old)).toEqual(old);
    expect(validateMessage({ ...old, ea: 1 })).toEqual({ ...old, ea: 1 });
    expect(validateMessage({ ...old, ea: true })).toEqual(old);
    expect(validateMessage({ ...old, ea: 2 })).toEqual(old);
  });

  it('accepts metadata, bounded chunk requests and a signed chunk without unknown fields', () => {
    const messages = [
      { ...addressed, t: 'anim-want' }, want,
      { ...addressed, t: 'anim-info', info }, { ...addressed, t: 'anim-info', info: null },
      { ...addressed, t: 'anim-chunk', a: info.a, i: 0, b: 'AQID' },
    ];
    for (const m of messages) expect(validateMessage({ ...m, injected: true })).toEqual(m);
  });

  it.each([
    { ...want, to: '../escape' }, { ...want, h: 'f'.repeat(64) }, { ...want, a: 'f'.repeat(32) },
    { ...want, need: [] }, { ...want, need: [-1] }, { ...want, need: [0.5] },
    { ...want, need: [ANIMATION_CHUNKS_MAX] }, { ...want, need: Array(ANIMATION_WINDOW + 1).fill(0) },
    { ...want, a: undefined }, { ...want, need: undefined },
    { ...addressed, t: 'anim-info', info: { ...info, size: ANIM_MAX_BYTES + 1 } },
    { ...addressed, t: 'anim-info', info: { ...info, size: 0 } },
    { ...addressed, t: 'anim-info', info: { ...info, format: 'svg' } },
    { ...addressed, t: 'anim-chunk', a: info.a, i: ANIMATION_CHUNKS_MAX, b: 'AQID' },
    { ...addressed, t: 'anim-chunk', a: info.a, i: 0, b: 'A'.repeat(724) },
    { ...addressed, t: 'anim-chunk', a: info.a, i: 0, b: '!bad' },
  ])('rejects malformed animation input %#', (raw) => {
    expect(validateMessage(raw)).toBeNull();
  });

  it('fits worst-case signed messages and a full 9-emote presence under the existing packet cap', () => {
    const identity = makeIdentity(new Uint8Array(32).fill(3));
    const key = Buffer.alloc(32, 5);
    const messages = [
      { ...want, need: Array.from({ length: ANIMATION_WINDOW }, (_, i) => ANIMATION_CHUNKS_MAX - 1 - i) },
      { ...addressed, t: 'anim-info', info },
      { ...addressed, t: 'anim-chunk', a: info.a, i: ANIMATION_CHUNKS_MAX - 1, b: 'A'.repeat(ANIMATION_CHUNK_BYTES / 3 * 4) },
      {
        ...base, t: 'presence', proto: 1, app: 'v'.repeat(64), name: '\u{1f600}'.repeat(16), color: 1,
        status: 'on', em: Array.from({ length: 9 }, (_, i) => i.toString().repeat(32)), nf: ['text', 'votes'],
        pk: identity.pk.toString('base64'), rgb: [255, 255, 255], ea: 1,
      },
    ];
    for (const raw of messages) {
      const msg = validateMessage(raw);
      expect(msg).not.toBeNull();
      if (!msg) throw new Error('invalid fixture');
      const bytes = encodeMessage(msg);
      const signed = joinSigned(new TextDecoder().decode(bytes), signBody(identity, bytes));
      const packet = seal(key, new TextEncoder().encode(signed));
      expect(packet.length).toBeLessThanOrEqual(MAX_PACKET);
      const plain = open(key, packet);
      expect(plain && decodeSigned(plain)?.msg).toEqual(msg as RoomMessage);
    }
  });
});
