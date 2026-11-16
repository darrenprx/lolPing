import { EMOTE_CATALOG } from './emoteCatalog';
import { catalogEmote } from './emotes';
import { ALL_PINGS, pingById, type PingId } from './pings';

/**
 * A bundled sound an imported image can play, by name: 'ping:' plus a ping id, or 'emote:' plus a bundled emote's slug.
 * Only the name travels in a room, so a friend plays it from their own copy.
 */
export type LeagueSoundRef = string;

const SHAPE = /^(ping|emote):[a-z0-9_]{1,40}$/;

/** Well-formed, whether or not this app ships it: a newer app may name a sound this one doesn't have. */
export const isLeagueSoundShape = (v: unknown): v is LeagueSoundRef => typeof v === 'string' && SHAPE.test(v);

/** The sound bank's key for a sound this app ships (a ping's sound file name, or 'emote:' plus the slug), else null. */
export function leagueSoundKey(ref: LeagueSoundRef): string | null {
  if (!isLeagueSoundShape(ref)) return null;
  const at = ref.indexOf(':');
  const name = ref.slice(at + 1);
  if (ref.slice(0, at) === 'ping') return pingById(name)?.sound ?? null;
  return catalogEmote(name)?.hasSound ? `emote:${name}` : null;
}

/** A name this app can play. */
export const isLeagueSound = (v: unknown): v is LeagueSoundRef => isLeagueSoundShape(v) && leagueSoundKey(v) !== null;

export interface LeagueSoundChoices {
  pings: { ref: LeagueSoundRef; ping: PingId }[];
  emotes: { ref: LeagueSoundRef; slug: string }[];
}

/** What the settings window offers: each ping sound once, under the first ping that plays it, then every emote with a sound. */
export function leagueSoundChoices(): LeagueSoundChoices {
  const seen = new Set<string>();
  const pings: LeagueSoundChoices['pings'] = [];
  for (const p of ALL_PINGS) {
    if (seen.has(p.sound)) continue;
    seen.add(p.sound);
    pings.push({ ref: `ping:${p.id}`, ping: p.id });
  }
  const emotes = EMOTE_CATALOG.filter((e) => e.hasSound).map((e) => ({ ref: `emote:${e.slug}`, slug: e.slug }));
  return { pings, emotes };
}
