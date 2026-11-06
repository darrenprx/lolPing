import { describe, expect, it } from 'vitest';
import { MAX_PACKET, open, seal } from '../../src/main/roomCrypto';
import {
  isTagColor, isTagRgb, nearestTagColor, readableTagRgb, sameTagRgb, TAG_COLORS, tagColorCss, tagHex, tagRgbFromHex, tagWire,
} from '../../src/shared/roomColors';
import {
  clampNameInput, decodeMessage, decodeSigned, encodeMessage, joinSigned, splitSigned, isOlderThan, isVoteId, MAX_TEXT, sanitizeName, sanitizeText, validateMessage,
  type AliveMsg, type BallotMsg, type ChunkMsg, type EmoteMsg, type PingMsg, type PresenceMsg, type RoomMessage, type TextMsg,
  type VoteMsg, type WantMsg,
} from '../../src/shared/roomProtocol';

const base = { peer: '0123456789abcdef', seq: 4, ts: 1_780_000_000_000 };
const presence: PresenceMsg = { ...base, t: 'presence', proto: 1, app: '0.3.0', name: 'Alex', color: 3, status: 'on', em: [], nf: [] };
const ping: PingMsg = { ...base, t: 'ping', ping: 'danger', d: 2, x: 0.25, y: 1 };
const emote: EmoteMsg = { ...base, t: 'emote', e: 'gg', d: 2, x: 0.25, y: 1 };
const text: TextMsg = { ...base, t: 'text', text: 'Group mid', d: 2, x: 0.25, y: 1 };
const CUSTOM_REF = `c:${'0123456789abcdef'.repeat(2)}`;

describe('encode / decode', () => {
  it.each<RoomMessage>([presence, ping, emote, text, { ...base, t: 'bye' }])('round-trips $t', (m) => {
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  it('rounds x and y to 4 decimals', () => {
    expect(decodeMessage(encodeMessage({ ...ping, x: 0.123456, y: 0.987654 }))).toMatchObject({ x: 0.1235, y: 0.9877 });
  });

  it('rounds an emote’s x and y to 4 decimals too', () => {
    expect(decodeMessage(encodeMessage({ ...emote, x: 0.123456, y: 0.987654 }))).toMatchObject({ x: 0.1235, y: 0.9877 });
  });

  it('rounds a text popup’s x and y to 4 decimals too', () => {
    expect(decodeMessage(encodeMessage({ ...text, x: 0.123456, y: 0.987654 }))).toMatchObject({ x: 0.1235, y: 0.9877 });
  });

  it('rejects bytes that are not JSON', () => {
    expect(decodeMessage(new TextEncoder().encode('{nope'))).toBeNull();
  });
});

describe('text messages', () => {
  it('sanitises unsafe characters and limits text by code point', () => {
    expect(sanitizeText('  Go\u202e mid\u0000  ')).toBe('Go mid');
    expect([...sanitizeText('😀'.repeat(MAX_TEXT + 5))]).toHaveLength(MAX_TEXT);
  });

  it('validates and keeps known fields only', () => {
    expect(validateMessage({ ...text, extra: 'ignored' })).toEqual(text);
    expect(validateMessage({ ...text, text: '  Go\u202e mid\u0000  ' })).toEqual({ ...text, text: 'Go mid' });
  });

  it('round-trips a history-only chat flag and leaves legacy text unchanged', () => {
    const chat: TextMsg = { ...text, overlay: false };
    expect(decodeMessage(encodeMessage(chat))).toEqual(chat);
    expect(decodeMessage(encodeMessage(text))).toEqual(text);
    for (const overlay of [undefined, true, null, 0, 'false', {}, []]) {
      expect(validateMessage({ ...text, overlay })).toEqual(text);
    }
  });

  it.each([
    ['empty text', { ...text, text: '' }],
    ['blank text', { ...text, text: '   ' }],
    ['non-string text', { ...text, text: 7 }],
    ['display 0', { ...text, d: 0 }],
    ['x above 1', { ...text, x: 1.1 }],
  ])('rejects %s', (_label, raw) => {
    expect(validateMessage(raw)).toBeNull();
  });
});

describe('room text, alive lines, votes and ballots', () => {
  const who = 'fedcba9876543210';
  const alive: AliveMsg = { ...base, t: 'alive', who, d: 1, x: 0.5, y: 0.25 };
  const ff: VoteMsg = { ...base, t: 'vote', id: '0a1b2c3d', kind: 'ff' };
  const kick: VoteMsg = { ...base, t: 'vote', id: '0a1b2c3d', kind: 'kick', target: who };
  const ballot: BallotMsg = { ...base, t: 'ballot', id: '0a1b2c3d', yes: true };

  it('cuts text to 120 code points and drops text that cleans to nothing', () => {
    expect(MAX_TEXT).toBe(120);
    const cut = validateMessage({ ...text, text: '字'.repeat(121) });
    expect(cut?.t === 'text' && [...cut.text]).toHaveLength(120);
    expect(validateMessage({ ...text, text: '\u200b\u202e' })).toBeNull();
    expect(validateMessage({ ...text, text: 'a\nb' })).toMatchObject({ text: 'ab' });
  });

  it('keeps a worst-case text packet under the sealed packet cap', () => {
    const key = Buffer.alloc(32, 7);
    const worst: TextMsg = { ...text, text: '😀'.repeat(120), overlay: false, d: 16, x: 0.1234, y: 0.5678 };
    const packet = seal(key, encodeMessage(worst));
    expect(packet.length).toBeLessThanOrEqual(MAX_PACKET);
    expect(decodeMessage(open(key, packet) ?? new Uint8Array())).toEqual(worst);
  });

  it('accepts alive, vote and ballot with good fields only', () => {
    for (const m of [alive, ff, kick, ballot]) expect(decodeMessage(encodeMessage(m))).toEqual(m);
    expect(validateMessage({ ...alive, extra: 1 })).toEqual(alive);
    for (const bad of [
      { ...alive, who: 'abc' },
      { ...alive, who: 'FEDCBA9876543210' },
      { ...alive, d: 0 },
      { ...alive, x: 2 },
      { ...ff, id: 'XYZ' },
      { ...ff, id: '0A1B2C3D' },
      { ...ff, kind: 'remake' },
      { ...ff, kind: 'kick' },
      { ...kick, target: 'nope' },
      { ...ff, target: who },
      { ...ballot, id: '1234' },
      { ...ballot, yes: 'true' },
      { ...ballot, yes: 1 },
    ]) expect(validateMessage(bad)).toBeNull();
  });

  it('rounds the position of an alive line like a ping', () => {
    expect(decodeMessage(encodeMessage({ ...alive, x: 0.123456, y: 0.987654 }))).toMatchObject({ x: 0.1235, y: 0.9877 });
  });

  it('knows a vote id: eight lower-case hex characters', () => {
    expect(isVoteId('0a1b2c3d')).toBe(true);
    for (const v of ['0a1b2c3', '0a1b2c3d4', '0A1B2C3D', 'ghijklmn', 7, null, undefined]) expect(isVoteId(v)).toBe(false);
  });

  it('reads nf as the known room features, once each', () => {
    expect(validateMessage({ ...presence, nf: ['text', 'text', 'votes', 'emotes', 3] })).toMatchObject({ nf: ['text', 'votes'] });
    expect(validateMessage({ ...presence, nf: 'text' })).toMatchObject({ t: 'presence', nf: [] });
    const { nf: _nf, ...old } = presence;
    expect(validateMessage(old)).toMatchObject({ nf: [] });
  });
});

describe('validateMessage', () => {
  it.each([
    ['unknown type', { ...presence, t: 'hello' }],
    ['short peer', { ...presence, peer: 'abc' }],
    ['upper-case peer', { ...presence, peer: '0123456789ABCDEF' }],
    ['negative seq', { ...presence, seq: -1 }],
    ['fractional seq', { ...presence, seq: 1.5 }],
    ['unsafe seq', { ...presence, seq: 2 ** 60 }],
    ['NaN ts', { ...presence, ts: Number.NaN }],
    ['unknown ping', { ...ping, ping: 'hold' }],
    ['display 0', { ...ping, d: 0 }],
    ['display 17', { ...ping, d: 17 }],
    ['fractional display', { ...ping, d: 1.5 }],
    ['x below 0', { ...ping, x: -0.01 }],
    ['x above 1', { ...ping, x: 1.01 }],
    ['infinite y', { ...ping, y: Infinity }],
    ['string x', { ...ping, x: '0.5' }],
    ['colour 8', { ...presence, color: 8 }],
    ['colour -1', { ...presence, color: -1 }],
    ['colour as CSS', { ...presence, color: 'red' }],
    ['unknown status', { ...presence, status: 'away' }],
    ['huge app version', { ...presence, app: 'x'.repeat(65) }],
    ['name not a string', { ...presence, name: 42 }],
    ['fractional proto', { ...presence, proto: 1.5 }],
  ])('rejects %s', (_label, raw) => {
    expect(validateMessage(raw)).toBeNull();
  });

  it('rejects non-objects', () => {
    for (const raw of [null, undefined, 3, 'x', [], [presence]]) expect(validateMessage(raw)).toBeNull();
  });

  it('keeps known fields only', () => {
    expect(validateMessage({ ...ping, extra: 'ignored' })).toEqual(ping);
  });

  it('cannot pollute prototypes', () => {
    const raw = JSON.parse('{"t":"bye","peer":"0123456789abcdef","seq":1,"ts":1,"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}');
    expect(validateMessage(raw)).toEqual({ t: 'bye', peer: '0123456789abcdef', seq: 1, ts: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts a presence from a newer protocol (the version check is the room’s job)', () => {
    expect(validateMessage({ ...presence, proto: 2 })).toEqual({ ...presence, proto: 2 });
  });

  it('sanitises the name', () => {
    expect(validateMessage({ ...presence, name: '‮Alex\u0000' })).toMatchObject({ name: 'Alex' });
  });

  it('carries a custom tag colour through, and drops a malformed one without dropping the member', () => {
    expect(validateMessage({ ...presence, rgb: [12, 34, 56] })).toEqual({ ...presence, rgb: [12, 34, 56] });
    // A bad custom colour costs the colour, never the member: the presence still validates on its palette index.
    for (const rgb of [[0, 0], [0, 0, 0, 0], [0, 0, 256], ['1', 2, 3], 'rgb(1,2,3)', 3]) {
      expect(validateMessage({ ...presence, rgb })).toEqual(presence);
    }
  });
});

describe('emote messages', () => {
  it('validates a bundled and a custom emote, and round-trips them', () => {
    for (const e of ['gg', CUSTOM_REF]) {
      const m: EmoteMsg = { ...emote, e };
      expect(validateMessage(m)).toEqual(m);
      expect(decodeMessage(encodeMessage(m))).toEqual(m);
    }
  });

  it('carries the sender’s chosen effect through', () => {
    const m: EmoteMsg = { ...emote, fx: 5 };
    expect(validateMessage(m)).toEqual(m);
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  it('drops a malformed effect rather than the emote, which then plays the plain pop', () => {
    for (const fx of [6, -1, 1.5, '5', null]) {
      expect(validateMessage({ ...emote, fx })).toEqual(emote);
    }
  });

  it('accepts a well-formed slug this version does not know (a newer peer’s emote)', () => {
    expect(validateMessage({ ...emote, e: 'brand_new_2' })).toEqual({ ...emote, e: 'brand_new_2' });
  });

  it.each([
    ['empty ref', { ...emote, e: '' }],
    ['upper-case slug', { ...emote, e: 'GG' }],
    ['slug with a path', { ...emote, e: '../gg' }],
    ['slug over 40 characters', { ...emote, e: 'a'.repeat(41) }],
    ['short custom hash', { ...emote, e: 'c:0123' }],
    ['upper-case custom hash', { ...emote, e: `c:${'ABCDEF0123456789'.repeat(2)}` }],
    ['non-string ref', { ...emote, e: 7 }],
    ['missing ref', { ...emote, e: undefined }],
    ['display 0', { ...emote, d: 0 }],
    ['display 17', { ...emote, d: 17 }],
    ['x above 1', { ...emote, x: 1.5 }],
    ['x below 0', { ...emote, x: -0.01 }],
    ['infinite y', { ...emote, y: Infinity }],
    ['string y', { ...emote, y: '0.5' }],
  ])('rejects %s', (_label, raw) => {
    expect(validateMessage(raw)).toBeNull();
  });

  it('keeps known fields only', () => {
    expect(validateMessage({ ...emote, extra: 'ignored', ping: 'danger' })).toEqual(emote);
  });
});

describe('presence announcements (em)', () => {
  const hash = '0123456789abcdef0123456789abcdef';
  const hash2 = 'fedcba9876543210fedcba9876543210';

  it('round-trips the announced hashes', () => {
    const m: PresenceMsg = { ...presence, em: [hash, hash2] };
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  it('reads a presence without em as announcing nothing (an app before 0.5.2)', () => {
    expect(validateMessage({ t: 'presence', peer: presence.peer, seq: 1, ts: 1, proto: 1, app: '0.5.1', name: 'A', color: 0, status: 'on' }))
      .toMatchObject({ em: [] });
  });

  it('rebuilds the list: malformed entries dropped, duplicates kept once, at most 9', () => {
    const raw = { ...presence, em: [hash, hash, 'XYZ', 7, hash2, `${hash}0`] };
    expect(validateMessage(raw)).toMatchObject({ em: [hash, hash2] });
    expect(validateMessage({ ...presence, em: Array.from({ length: 20 }, () => hash) })).toMatchObject({ em: [hash] });
    const many = [hash, hash2, ...Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, '0'))];
    expect(validateMessage({ ...presence, em: many })).toMatchObject({ em: many.slice(0, 9) });
  });

  it.each([
    ['em not an array', { ...presence, em: hash }],
    ['em entry not a string', { ...presence, em: [7] }],
    ['em entry upper-case', { ...presence, em: [hash.toUpperCase()] }],
    ['em entry short', { ...presence, em: ['0123'] }],
  ])('reads %s as announcing nothing', (_label, raw) => {
    expect(validateMessage(raw)).toMatchObject({ em: [] });
  });
});

describe('want and chunk messages', () => {
  const hash = '0123456789abcdef0123456789abcdef';
  const want: WantMsg = { ...base, t: 'want', to: 'fedcba9876543210', h: hash, need: [0, 2] };
  const chunk: ChunkMsg = { ...base, t: 'chunk', h: hash, i: 0, n: 17, b: Buffer.from('x'.repeat(750)).toString('base64') };

  it('round-trips a want and a chunk', () => {
    expect(decodeMessage(encodeMessage(want))).toEqual(want);
    expect(decodeMessage(encodeMessage(chunk))).toEqual(chunk);
  });

  it('deduplicates a want’s need list', () => {
    expect(validateMessage({ ...want, need: [2, 2, 0, 2] })).toMatchObject({ need: [2, 0] });
  });

  it.each([
    ['to that is not a peer id', { ...want, to: 'nope' }],
    ['to shaped like a hash', { ...want, to: hash }],
    ['hash upper-case', { ...want, h: hash.toUpperCase() }],
    ['need not an array', { ...want, need: 0 }],
    ['need over 64 entries', { ...want, need: Array(65).fill(0) }],
    ['need index at the chunk max', { ...want, need: [17] }],
    ['need index negative', { ...want, need: [-1] }],
    ['chunk count 0', { ...chunk, n: 0 }],
    ['chunk count 18', { ...chunk, n: 18 }],
    ['index at the count', { ...chunk, i: 17 }],
    ['index above the count', { ...chunk, n: 3, i: 3 }],
    ['base64 over 1000 characters', { ...chunk, b: 'QQ'.repeat(501) }],
    ['base64 of a ragged length', { ...chunk, b: 'QQQ' }],
    ['base64 with a stray character', { ...chunk, b: `${'A'.repeat(999)}*` }],
    ['base64 not a string', { ...chunk, b: 9 }],
  ])('rejects %s', (_label, raw) => {
    expect(validateMessage(raw)).toBeNull();
  });

  it('accepts an empty need (all of it) and a full-size chunk', () => {
    expect(validateMessage({ ...want, need: [] })).toMatchObject({ need: [] });
    expect(validateMessage(chunk)).toEqual(chunk);
  });
});

describe('isOlderThan', () => {
  it('is true only for a plain x.y.z version that is lower', () => {
    expect(isOlderThan('0.4.0', '0.5.0')).toBe(true);
    expect(isOlderThan('0.4.9', '0.5.0')).toBe(true);
    expect(isOlderThan('0.5.0', '0.5.0')).toBe(false);
    expect(isOlderThan('0.5.1', '0.5.0')).toBe(false);
    expect(isOlderThan('1.0.0', '0.5.0')).toBe(false);
    expect(isOlderThan('0.10.0', '0.9.0')).toBe(false); // numbers, not text
    expect(isOlderThan('0.9.0', '0.10.0')).toBe(true);
  });

  it('is false for anything else, so an unknown build is never called old', () => {
    for (const app of ['room-peer', '0.4', '', '0.4.0-beta', 'v0.4.0', '0.4.0.1', '0.-4.0']) expect(isOlderThan(app, '0.5.0')).toBe(false);
  });
});

describe('sanitizeName', () => {
  it('strips control, bidi and zero-width characters', () => {
    expect(sanitizeName('\u0007A​l‪e⁦x\u007f\u0085﻿')).toBe('Alex');
  });

  it('strips line separators, Arabic letter mark, soft hyphen, Mongolian vowel separator, Hangul fillers and CGJ', () => {
    expect(sanitizeName('A l e؜x᠎­͏')).toBe('Alex');
    expect(sanitizeName('ᅟᅠㅤﾠ')).toBe('Player');
  });

    it('trims and cuts to 16 code points, counting an emoji as one', () => {
    expect(sanitizeName('  Bob  ')).toBe('Bob');
    expect(sanitizeName('🎮'.repeat(20))).toBe('🎮'.repeat(16));
    expect(sanitizeName('x'.repeat(40))).toHaveLength(16);
  });

  it('cuts to a longer limit when asked', () => {
    expect(sanitizeName('x'.repeat(40), 'Player', 24)).toBe('x'.repeat(24));
    expect(sanitizeName('x'.repeat(40), 'Player', 24)).not.toBe(sanitizeName('x'.repeat(40)));
  });

  it('falls back when nothing is left', () => {
    expect(sanitizeName('   ')).toBe('Player');
    expect(sanitizeName('​', 'Darren')).toBe('Darren');
  });
});

describe('clampNameInput', () => {
  it('limits typing to 16 code points, so 16 emoji fit (a UTF-16 maxLength allowed only 8)', () => {
    expect(clampNameInput('🎮'.repeat(20))).toBe('🎮'.repeat(16));
    expect(clampNameInput('x'.repeat(20))).toHaveLength(16);
    expect(clampNameInput(' Bob ')).toBe(' Bob '); // no trimming while typing
  });
});

describe('tag colours', () => {
  it('has 8 distinct colours', () => {
    expect(TAG_COLORS).toHaveLength(8);
    expect(new Set(TAG_COLORS).size).toBe(8);
  });

  it('accepts palette indexes only', () => {
    expect(isTagColor(0)).toBe(true);
    expect(isTagColor(7)).toBe(true);
    for (const v of [8, -1, 1.5, '1', null]) expect(isTagColor(v)).toBe(false);
  });

  it('accepts a custom colour as three channels, and nothing else', () => {
    expect(isTagRgb([0, 0, 0])).toBe(true);
    expect(isTagRgb([255, 128, 7])).toBe(true);
    for (const v of [
      [0, 0], [0, 0, 0, 0], [0, 0, 256], [0, 0, -1], [0, 0, 1.5], ['1', 2, 3], 'rgb(1,2,3)', null, undefined, 3, {},
    ]) expect(isTagRgb(v)).toBe(false);
  });

  it('lifts a colour too dark for the dark pill, and leaves a readable one alone', () => {
    expect(readableTagRgb([255, 255, 255])).toEqual([255, 255, 255]);
    expect(readableTagRgb([79, 195, 247])).toEqual([79, 195, 247]); // the sky entry already reads

    const lifted = readableTagRgb([0, 0, 0]);
    expect(lifted[0]).toBe(lifted[1]);
    expect(lifted[1]).toBe(lifted[2]); // neutral in, neutral out: the hue did not move
    expect(lifted[0]).toBeGreaterThan(100);
    expect(readableTagRgb(lifted)).toEqual(lifted); // already at the floor: a second pass changes nothing
  });

  it('builds CSS from numbers only, so nothing off the network reaches a style', () => {
    expect(tagColorCss(0, null)).toBe(TAG_COLORS[0]);
    expect(tagColorCss(99, null)).toBe(TAG_COLORS[0]); // out of range falls back
    expect(tagColorCss(0, undefined)).toBe(TAG_COLORS[0]);
    // A colour that already reads is used as it is, still built here from three numbers.
    expect(tagColorCss(0, [255, 0, 0])).toBe('rgb(255, 0, 0)');
    // A dark one is clamped before it becomes CSS, and the result is still just three numbers.
    expect(tagColorCss(0, [0, 0, 0])).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(tagColorCss(0, [0, 0, 0])).not.toBe('rgb(0, 0, 0)');
  });

  it('matches a custom colour to the nearest palette entry for older builds', () => {
    expect(nearestTagColor([79, 195, 247])).toBe(0); // exactly sky
    expect(nearestTagColor([80, 195, 245])).toBe(0); // near sky
    expect(nearestTagColor([224, 224, 224])).toBe(7); // exactly silver
    for (const rgb of [[0, 0, 0], [255, 255, 255], [12, 200, 130]] as const) {
      expect(isTagColor(nearestTagColor(rgb))).toBe(true);
    }
  });

  it('round-trips a picker value and rejects anything that is not #rrggbb', () => {
    expect(tagHex([79, 195, 247])).toBe('#4fc3f7');
    expect(tagHex([0, 0, 0])).toBe('#000000');
    expect(tagRgbFromHex('#4fc3f7')).toEqual([79, 195, 247]);
    for (const hex of ['4fc3f7', '#4fc3f', '#4fc3f7f', '#gggggg', 'red', '']) expect(tagRgbFromHex(hex)).toBeNull();
  });

  it('compares custom colours by value, since they are arrays', () => {
    expect(sameTagRgb(null, null)).toBe(true);
    expect(sameTagRgb([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameTagRgb([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(sameTagRgb([1, 2, 3], null)).toBe(false);
    expect(sameTagRgb(null, [1, 2, 3])).toBe(false);
  });

  it('keeps color a palette index on the wire, so a peer on an older build still accepts the presence', () => {
    expect(tagWire(3, null)).toEqual({ color: 3, rgb: null });
    const wire = tagWire(3, [10, 20, 30]);
    expect(isTagColor(wire.color)).toBe(true);
    expect(wire.rgb).toEqual([10, 20, 30]);
    // The index is the nearest palette entry rather than the stored one, so older builds show something close.
    expect(tagWire(3, [79, 195, 247]).color).toBe(0);
  });
});

describe('message signatures', () => {
  const SIG = `${'A'.repeat(86)}==`;
  const enc = (m: RoomMessage): string => new TextDecoder().decode(encodeMessage(m));
  const bytes = (v: string): Uint8Array => new TextEncoder().encode(v);

  it('appends the signature as a last field and splits it back off exactly', () => {
    const signed = joinSigned('{"t":"bye"}', SIG);
    expect(signed).toBe(`{"t":"bye","sg":"${SIG}"}`);
    expect(splitSigned(signed)).toEqual({ body: '{"t":"bye"}', sig: SIG });
  });

  it('treats a missing, short or misplaced signature as unsigned', () => {
    expect(splitSigned('{"t":"bye"}')).toBeNull();
    expect(splitSigned(`{"t":"bye","sg":"${'A'.repeat(85)}=="}`)).toBeNull();
    expect(splitSigned(`{"sg":"${SIG}","t":"bye"}`)).toBeNull();
  });

  it('still reads as a plain message for an app that knows nothing of signatures', () => {
    const bye: RoomMessage = { ...base, t: 'bye' };
    const decoded = decodeMessage(bytes(joinSigned(enc(bye), SIG)));
    expect(decoded).toEqual(bye);
    expect(decoded).not.toHaveProperty('sg');
  });

  it('gives back the signed bytes, or the whole plaintext when unsigned', () => {
    const body = enc(ping);
    expect(decodeSigned(bytes(joinSigned(body, SIG)))).toEqual({ msg: ping, body: bytes(body), sig: SIG });
    expect(decodeSigned(bytes(body))).toEqual({ msg: ping, body: bytes(body), sig: null });
    expect(decodeSigned(bytes('not json'))).toBeNull();
  });

  it('keeps a well-formed public key on a presence and drops a bad one, not the presence', () => {
    const pk = `${'B'.repeat(43)}=`;
    expect(validateMessage({ ...presence, pk })).toEqual({ ...presence, pk });
    for (const bad of [`${'B'.repeat(42)}=`, `${'B'.repeat(43)}!`, 7]) expect(validateMessage({ ...presence, pk: bad })).toEqual(presence);
  });

  it('fits the largest signed presence in one packet', () => {
    const worst: PresenceMsg = {
      ...base, seq: Number.MAX_SAFE_INTEGER, t: 'presence', proto: 1, app: '9'.repeat(64), name: '😀'.repeat(16), color: 7,
      rgb: [255, 255, 255], status: 'paused', em: Array.from({ length: 9 }, (_, i) => String(i).repeat(32)),
      nf: ['text', 'votes'], pk: `${'B'.repeat(43)}=`,
    };
    const sealed = seal(Buffer.alloc(32), bytes(joinSigned(enc(worst), SIG)));
    expect(sealed.length).toBeLessThanOrEqual(MAX_PACKET);
  });
});
