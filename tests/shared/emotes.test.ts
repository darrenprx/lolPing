import { describe, expect, it } from 'vitest';
import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG } from '../../src/shared/emoteCatalog';
import {
  allEmoteAssetFiles, catalogEmote, customAnimUrl, customHash, customStillUrl, emoteAnimUrl, emoteIconUrl, emoteName,
  emoteSoundUrl, isBundledEmote, isCustomRef, isEmoteRefShape, normalizeClickEmote, normalizeEmoteWheel, type CustomEmote,
} from '../../src/shared/emotes';

const HASH = 'a'.repeat(32);
const HASH_B = 'b'.repeat(32);
const custom = (hash: string, name = 'Mine', animated = false): CustomEmote => ({ id: `c:${hash}`, name, animated });

describe('emote refs', () => {
  it('recognises ref shapes', () => {
    expect(isEmoteRefShape('thumbs_up')).toBe(true);
    expect(isEmoteRefShape(`c:${HASH}`)).toBe(true);
    for (const bad of [`C:${HASH.toUpperCase()}`, `c:${'a'.repeat(31)}`, `c:${'a'.repeat(33)}`, 'Thumbs', '', 'a'.repeat(41), 42, null, undefined]) {
      expect(isEmoteRefShape(bad)).toBe(false);
    }
  });

  it('accepts every catalog slug as a ref shape', () => {
    for (const e of EMOTE_CATALOG) expect(isEmoteRefShape(e.slug)).toBe(true);
  });

  it('tells custom refs from bundled ones', () => {
    expect(isCustomRef(`c:${HASH}`)).toBe(true);
    expect(isCustomRef('facepalm')).toBe(false);
    expect(isCustomRef(`c:${'g'.repeat(32)}`)).toBe(false);
    expect(isCustomRef(7)).toBe(false);
  });

  it('bundled means in the catalog', () => {
    for (const e of EMOTE_CATALOG) expect(isBundledEmote(e.slug)).toBe(true);
    expect(isEmoteRefShape('not_in_catalog')).toBe(true);
    expect(isBundledEmote('not_in_catalog')).toBe(false);
    expect(isBundledEmote(`c:${HASH}`)).toBe(false);
  });

  it('looks up catalog entries', () => {
    expect(catalogEmote('facepalm')?.leagueId).toBe(4341);
    expect(catalogEmote('nope')).toBeUndefined();
  });

  it('builds asset urls', () => {
    expect(emoteAnimUrl('facepalm')).toBe('../emotes/facepalm.webp');
    expect(emoteIconUrl('facepalm')).toBe('../emotes/facepalm.png');
    expect(emoteSoundUrl('facepalm')).toBe('../emotes/facepalm.ogg');
    expect(customHash(`c:${HASH}`)).toBe(HASH);
    expect(customStillUrl(HASH)).toBe(`lolping://emotes/${HASH}.webp`);
    expect(customAnimUrl(HASH)).toBe(`lolping://emotes/${HASH}.anim`);
  });
});

describe('normalizeEmoteWheel', () => {
  it('falls back to the default wheel', () => {
    expect(normalizeEmoteWheel(undefined, [])).toEqual(DEFAULT_EMOTE_WHEEL);
    const seven = DEFAULT_EMOTE_WHEEL.slice(0, 7);
    const dup = [...DEFAULT_EMOTE_WHEEL.slice(0, 7), DEFAULT_EMOTE_WHEEL[0]];
    for (const raw of [seven, dup, 'facepalm', null, [...DEFAULT_EMOTE_WHEEL.slice(0, 7), 42]]) {
      expect(normalizeEmoteWheel(raw, [])).toEqual(DEFAULT_EMOTE_WHEEL);
    }
  });

  it('returns a fresh array', () => {
    expect(normalizeEmoteWheel(undefined, [])).not.toBe(DEFAULT_EMOTE_WHEEL);
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    expect(normalizeEmoteWheel(wheel, [])).not.toBe(wheel);
  });

  it('keeps a valid wheel, including bundled slugs that are not the default', () => {
    const wheel = ['facepalm', ...DEFAULT_EMOTE_WHEEL.slice(1)];
    expect(normalizeEmoteWheel(wheel, [])).toEqual(wheel);
  });

  it('keeps a custom ref that is in the custom list', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[3] = `c:${HASH}`;
    expect(normalizeEmoteWheel(wheel, [custom(HASH)])).toEqual(wheel);
  });

  it('replaces a custom ref that is missing from the list with the default for that slot', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[3] = `c:${HASH}`;
    const out = normalizeEmoteWheel(wheel, [custom(HASH_B)]);
    expect(out[3]).toBe(DEFAULT_EMOTE_WHEEL[3]);
    expect(out).toEqual(DEFAULT_EMOTE_WHEEL);
  });

  it('replaces an unknown slug the same way', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[0] = 'not_in_catalog';
    expect(normalizeEmoteWheel(wheel, [])).toEqual(DEFAULT_EMOTE_WHEEL);
  });

  it('picks the first free catalog slug when the slot default is already on the wheel', () => {
    // Slot 3's default sits in slot 0, and slot 3 holds a custom ref that isn't known.
    const wheel = [DEFAULT_EMOTE_WHEEL[3], ...DEFAULT_EMOTE_WHEEL.slice(1, 3), `c:${HASH}`, ...DEFAULT_EMOTE_WHEEL.slice(4)];
    const out = normalizeEmoteWheel(wheel, []);
    const free = EMOTE_CATALOG.map((e) => e.slug).find((s) => !wheel.includes(s));
    expect(out[3]).toBe(free);
    expect(new Set(out).size).toBe(8);
  });

  it('never repeats a ref when several slots are replaced', () => {
    // Slot 0 repeats slot 1's default; slots 1 and 2 hold custom refs that don't exist.
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[0] = DEFAULT_EMOTE_WHEEL[1];
    wheel[1] = `c:${HASH}`;
    wheel[2] = `c:${HASH_B}`;
    const out = normalizeEmoteWheel(wheel, []);
    expect(new Set(out).size).toBe(8);
    expect(out.every(isBundledEmote)).toBe(true);
    expect(out[0]).toBe(DEFAULT_EMOTE_WHEEL[1]); // a valid ref is never the one that moves
  });
});

describe('normalizeClickEmote', () => {
  it('normalizes the centre', () => {
    expect(normalizeClickEmote('not_in_catalog', [])).toBe(DEFAULT_CLICK_EMOTE);
    expect(normalizeClickEmote(7, [])).toBe(DEFAULT_CLICK_EMOTE);
    expect(normalizeClickEmote(undefined, [])).toBe(DEFAULT_CLICK_EMOTE);
    expect(normalizeClickEmote('gasp', [])).toBe('gasp');
  });

  it('keeps a known custom ref and drops an unknown one', () => {
    expect(normalizeClickEmote(`c:${HASH}`, [custom(HASH)])).toBe(`c:${HASH}`);
    expect(normalizeClickEmote(`c:${HASH}`, [custom(HASH_B)])).toBe(DEFAULT_CLICK_EMOTE);
  });
});

describe('asset files', () => {
  it('lists asset files', () => {
    const files = allEmoteAssetFiles();
    const sounds = EMOTE_CATALOG.filter((e) => e.hasSound).length;
    expect(files).toHaveLength(EMOTE_CATALOG.length * 2 + sounds);
    expect(files).toContain('emotes/facepalm.webp');
    expect(files).toContain('emotes/facepalm.png');
    expect(files).toContain('emotes/facepalm.ogg');
    expect(new Set(files).size).toBe(files.length);
  });

  it('skips the sound of an emote without one', () => {
    for (const e of EMOTE_CATALOG.filter((c) => !c.hasSound)) expect(allEmoteAssetFiles()).not.toContain(`emotes/${e.slug}.ogg`);
  });
});

describe('emoteName', () => {
  it('names bundled emotes in the language asked for', () => {
    expect(emoteName('facepalm', 'en', [])).toBe('Facepalm');
    expect(emoteName('facepalm', 'zh-CN', [])).toBe('捂脸');
  });

  it('names a custom emote by its stored name', () => {
    expect(emoteName(`c:${HASH}`, 'en', [custom(HASH, 'My Cat')])).toBe('My Cat');
    expect(emoteName(`c:${HASH}`, 'zh-CN', [custom(HASH, 'My Cat')])).toBe('My Cat');
  });

  it('gives ? for a ref it does not know', () => {
    expect(emoteName('not_in_catalog', 'en', [])).toBe('?');
    expect(emoteName(`c:${HASH}`, 'en', [])).toBe('?');
  });
});
