import { catalogEmote, customHash, customStillUrl, emoteIconUrl, type EmoteRef } from '../../shared/emotes';
import { FALLBACK_TEXTURE, pingById, textureUrl, type PingDef, type PingId } from '../../shared/pings';
import type { OverlaySettings } from '../../shared/settings';
import type { WheelItem } from './wheel';

const UNKNOWN_ICON = textureUrl(FALLBACK_TEXTURE);

export const pingItem = (p: PingDef): WheelItem => ({ key: p.id, icon: textureUrl(p.icon) });

/** A wheel slot's icon: the bundled emote's, the imported emote's still, or the generic ping for one that isn't known. */
export function emoteItem(ref: EmoteRef, customEmotes: OverlaySettings['customEmotes']): WheelItem {
  if (catalogEmote(ref)) return { key: ref, icon: emoteIconUrl(ref) };
  if (customEmotes.some((c) => c.id === ref)) return { key: ref, icon: customStillUrl(customHash(ref)) };
  return { key: ref, icon: UNKNOWN_ICON };
}

const pingIcon = (id: PingId): string => {
  const def = pingById(id);
  return def ? textureUrl(def.icon) : UNKNOWN_ICON;
};

/** What each wheel's centre shows: what trigger + click would place. */
export function centerIcons(s: Pick<OverlaySettings, 'clickPingId' | 'clickEmoteId' | 'customEmotes'>): { ping: string; emote: string } {
  return { ping: pingIcon(s.clickPingId), emote: emoteItem(s.clickEmoteId, s.customEmotes).icon };
}
