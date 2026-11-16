import { describe, expect, it } from 'vitest';
import { EMOTE_CATALOG } from '../../src/shared/emoteCatalog';
import { isLeagueSound, isLeagueSoundShape, leagueSoundChoices, leagueSoundKey } from '../../src/shared/leagueSounds';
import { ALL_PINGS } from '../../src/shared/pings';

describe('leagueSounds', () => {
  it('finds the sound bank key of a ping sound and of an emote sound', () => {
    expect(leagueSoundKey('ping:danger')).toBe('SRP_12');
    expect(leagueSoundKey('ping:omw')).toBe('OnMyWay');
    expect(leagueSoundKey('emote:facepalm')).toBe('emote:facepalm');
  });

  it('knows no key for a name it does not ship, or a bundled emote without a sound', () => {
    const silent = EMOTE_CATALOG.find((e) => !e.hasSound);
    if (silent) expect(leagueSoundKey(`emote:${silent.slug}`)).toBeNull();
    expect(leagueSoundKey('ping:from_the_future')).toBeNull();
    expect(leagueSoundKey('emote:from_the_future')).toBeNull();
    expect(leagueSoundKey('ward:danger')).toBeNull();
  });

  it('accepts any well-formed name in a message, and only a shipped one in settings', () => {
    expect(isLeagueSoundShape('emote:from_the_future')).toBe(true);
    expect(isLeagueSound('emote:from_the_future')).toBe(false);
    expect(isLeagueSound('ping:bait')).toBe(true);
    for (const v of ['ping:', 'ping:Danger', 'ping:../danger', `emote:${'a'.repeat(41)}`, 'danger', 'ping:danger ', 7, null]) {
      expect(isLeagueSoundShape(v)).toBe(false);
    }
  });

  it('offers each ping sound once and every emote that has a sound', () => {
    const { pings, emotes } = leagueSoundChoices();
    expect(pings.map((p) => p.ref)).not.toContain('ping:missingflip'); // the same MIA sound as Enemy Missing
    expect(pings.map((p) => p.ref)).toContain('ping:missing');
    expect(new Set(pings.map((p) => leagueSoundKey(p.ref))).size).toBe(new Set(ALL_PINGS.map((p) => p.sound)).size);
    expect(emotes).toHaveLength(EMOTE_CATALOG.filter((e) => e.hasSound).length);
    for (const c of [...pings, ...emotes]) expect(isLeagueSound(c.ref)).toBe(true);
  });
});
