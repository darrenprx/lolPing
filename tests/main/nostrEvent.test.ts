import { createHash } from 'node:crypto';
import { schnorr } from '@noble/secp256k1';
import { describe, expect, it } from 'vitest';
import {
  closeMessage, eventMessage, makeKeyPair, parseRelayMessage, reqMessage, serializeEvent, signEvent,
} from '../../src/main/nostrEvent';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const PK = 'a'.repeat(64);

describe('events', () => {
  it('serializes per NIP-01', () => {
    const s = serializeEvent(PK, 1700000000, 24747, [['x', 'ab']], 'hi');
    expect(s).toBe(`[0,"${PK}",1700000000,24747,[["x","ab"]],"hi"]`);
  });

  it('ids an event by the SHA-256 of its serialization', () => {
    const keys = makeKeyPair();
    const e = signEvent(keys, 24747, [['x', 'ab']], 'hi', 1700000000);
    const expected = createHash('sha256').update(serializeEvent(keys.pubkey, 1700000000, 24747, [['x', 'ab']], 'hi')).digest('hex');
    expect(e.id).toBe(expected);
    expect(e).toMatchObject({ pubkey: keys.pubkey, created_at: 1700000000, kind: 24747, tags: [['x', 'ab']], content: 'hi' });
  });

  it('matches BIP-340 test vector 0', () => {
    const sk = new Uint8Array(32);
    sk[31] = 3;
    const zero = new Uint8Array(32);
    expect(hex(schnorr.getPublicKey(sk))).toBe('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
    expect(hex(schnorr.sign(zero, sk, zero))).toBe(
      'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0',
    );
  });

  it('signs events that verify, with a fresh key each time', () => {
    const keys = makeKeyPair();
    const e = signEvent(keys, 24747, [], '', 1700000000);
    expect(keys.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(e.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(schnorr.verify(bytes(e.sig), bytes(e.id), bytes(e.pubkey))).toBe(true);
    expect(makeKeyPair().pubkey).not.toBe(keys.pubkey);
  });

  it('builds the messages sent to relays', () => {
    expect(JSON.parse(reqMessage('lolping', 'ab', 1700000000))).toEqual(
      ['REQ', 'lolping', { kinds: [24747], '#x': ['ab'], since: 1700000000, limit: 0 }],
    );
    const e = signEvent(makeKeyPair(), 24747, [], 'c', 1);
    expect(JSON.parse(eventMessage(e))).toEqual(['EVENT', e]);
    expect(JSON.parse(closeMessage('lolping'))).toEqual(['CLOSE', 'lolping']);
  });
});

describe('parseRelayMessage', () => {
  const event = signEvent(makeKeyPair(), 24747, [['x', 'ab']], 'hi', 1700000000);

  it('parses each relay message type', () => {
    expect(parseRelayMessage(JSON.stringify(['EVENT', 's', event]))).toEqual({ type: 'EVENT', subId: 's', event });
    expect(parseRelayMessage(JSON.stringify(['OK', event.id, false, 'rate-limited: slow down']))).toEqual(
      { type: 'OK', eventId: event.id, ok: false, message: 'rate-limited: slow down' },
    );
    expect(parseRelayMessage(JSON.stringify(['OK', event.id, true]))).toEqual({ type: 'OK', eventId: event.id, ok: true, message: '' });
    expect(parseRelayMessage('["EOSE","s"]')).toEqual({ type: 'EOSE', subId: 's' });
    expect(parseRelayMessage('["CLOSED","s","error: shutting down"]')).toEqual({ type: 'CLOSED', subId: 's', message: 'error: shutting down' });
    expect(parseRelayMessage('["NOTICE","hello"]')).toEqual({ type: 'NOTICE', message: 'hello' });
  });

  it('rejects junk', () => {
    const bad = (patch: Record<string, unknown>): string => JSON.stringify(['EVENT', 's', { ...event, ...patch }]);
    for (const text of [
      'not json', '{"a":1}', '[]', '["AUTH","challenge"]', '["EVENT","s"]', '["EOSE"]',
      bad({ id: 'xyz' }), bad({ sig: 'ab' }), bad({ pubkey: 'A'.repeat(64) }), bad({ created_at: 1.5 }),
      bad({ kind: '24747' }), bad({ tags: [['x', 1]] }), bad({ tags: 'x' }), bad({ content: 5 }),
      JSON.stringify(['OK', event.id, 'yes', '']), JSON.stringify(['OK', 'short', true, '']),
    ]) {
      expect(parseRelayMessage(text), text).toBeNull();
    }
  });

  it('ignores prototype-pollution keys', () => {
    const text = JSON.stringify(['EVENT', 's', event]).replace('{"id"', '{"__proto__":{"polluted":1},"id"');
    const parsed = parseRelayMessage(text);
    expect(parsed?.type).toBe('EVENT');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys((parsed as { event: object }).event).sort()).toEqual(['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']);
  });
});
