import { describe, expect, it } from 'vitest';
import { centerIcons, emoteItem } from '../../src/renderer/overlay/wheelItems';
import { customStillUrl, emoteIconUrl } from '../../src/shared/emotes';
import { FALLBACK_TEXTURE, textureUrl } from '../../src/shared/pings';

const HASH = 'a'.repeat(32);
const custom = [{ id: `c:${HASH}`, name: 'Mine', animated: false }];

describe('wheelItems', () => {
  it('shows the chosen click emote and click ping in the centres, not the first defaults', () => {
    expect(centerIcons({ clickPingId: 'push', clickEmoteId: 'poro_snax', customEmotes: [] }))
      .toEqual({ ping: textureUrl('pingwheel_pushrender'), emote: emoteIconUrl('poro_snax') });
  });

  it("shows an imported click emote's still in the centre", () => {
    expect(centerIcons({ clickPingId: 'push', clickEmoteId: `c:${HASH}`, customEmotes: custom }).emote).toBe(customStillUrl(HASH));
  });

  it('falls back to the generic ping for an emote this app does not know', () => {
    expect(emoteItem(`c:${'b'.repeat(32)}`, custom).icon).toBe(textureUrl(FALLBACK_TEXTURE));
  });
});
