import { DEFAULT_CLICK_EMOTE, EMOTE_CATALOG } from '../../shared/emoteCatalog';
import {
  allEmoteAssetFiles, catalogEmote, customAnimUrl, customHash, customStillUrl, emoteIconUrl, emoteSoundUrl, isBundledEmote,
  type EmoteArt, type EmoteRef,
} from '../../shared/emotes';
import {
  DEFAULT_CLICK_PING, TICK_SOUND, allSoundNames, allTextureNames, pingById, pingsFor, soundUrl, textureUrl, type PingDef,
} from '../../shared/pings';
import type { PingTag } from '../../shared/ipc';
import type { WheelKind } from '../../shared/protocol';
import { DEFAULT_SETTINGS, overlaySettings, type OverlaySettings } from '../../shared/settings';
import { EmoteStage } from './emoteFx';
import { spawnPing } from './pingFx';
import { SoundBank } from './soundBank';
import { showToast } from './toast';
import { Wheel, type WheelItem } from './wheel';

const pingLayer = document.getElementById('pings') as HTMLElement;
const toastLayer = document.getElementById('toasts') as HTMLElement;
const pingSvg = document.getElementById('wheel') as unknown as SVGSVGElement;

// The emote wheel is a second copy of the ping wheel's svg, and its emotes get a layer of their own above the pings.
const emoteSvg = pingSvg.cloneNode(false) as SVGSVGElement;
emoteSvg.id = 'emoteWheel';
pingSvg.after(emoteSvg);
const emoteLayer = document.createElement('div');
emoteLayer.id = 'emotes';
pingLayer.after(emoteLayer);

const sounds = new SoundBank();
const stage = new EmoteStage(emoteLayer);
let settings: OverlaySettings = overlaySettings(DEFAULT_SETTINGS);
const [fallbackPing] = pingsFor([DEFAULT_CLICK_PING]);
const volume = (): number => (settings.muted ? 0 : settings.volume / 100);

const tick = (): void => {
  if (settings.tickSound) sounds.play(TICK_SOUND, volume() * 0.5);
};
const pingWheel = new Wheel(pingSvg, 'PING', textureUrl('generic_ping'), tick);
const emoteWheel = new Wheel(emoteSvg, 'EMOTE', emoteIconUrl(DEFAULT_CLICK_EMOTE), tick);

const pingItem = (p: PingDef): WheelItem => ({ key: p.id, icon: textureUrl(p.icon) });

/** A wheel slot's icon: the bundled emote's, the imported emote's still, or the generic ping for one that isn't known. */
function emoteItem(ref: EmoteRef): WheelItem {
  if (catalogEmote(ref)) return { key: ref, icon: emoteIconUrl(ref) };
  if (settings.customEmotes.some((c) => c.id === ref)) return { key: ref, icon: customStillUrl(customHash(ref)) };
  return { key: ref, icon: textureUrl('generic_ping') };
}

/** This machine's own emotes: the settings know what an imported one looks like, and whether it moves. */
function localArt(ref: EmoteRef): EmoteArt {
  if (isBundledEmote(ref)) return { kind: 'bundled', slug: ref };
  const custom = settings.customEmotes.find((c) => c.id === ref);
  if (!custom) return { kind: 'placeholder' };
  const hash = customHash(ref);
  return { kind: 'custom', url: custom.animated ? customAnimUrl(hash) : customStillUrl(hash), animated: custom.animated };
}

function applySettings(s: OverlaySettings): void {
  settings = s;
  pingWheel.setItems(pingsFor(s.wheel).map(pingItem));
  emoteWheel.setItems(s.emoteWheel.map(emoteItem));
}
applySettings(settings);

function ping(def: PingDef, x: number, y: number, tag?: PingTag): void {
  spawnPing(pingLayer, def, x, y, { sizePx: settings.pingSizePx, durationS: settings.pingDurationS, tag });
  sounds.play(def.sound, volume());
}

function emote(owner: string, art: EmoteArt, x: number, y: number, tag?: PingTag): void {
  stage.spawn(owner, art, x, y, { sizePx: settings.emoteSizePx, tag });
  if (art.kind === 'bundled' && catalogEmote(art.slug)?.hasSound && settings.emoteSound) sounds.play(`emote:${art.slug}`, volume());
}

const wheelOf = (p: { wheel?: WheelKind }): Wheel => (p.wheel === 'emote' ? emoteWheel : pingWheel);

window.overlay.on('overlay:settings', applySettings);
window.overlay.on('wheel:open', (p) => wheelOf(p).open(p.x, p.y));
window.overlay.on('wheel:move', (p) => wheelOf(p).move(p.x, p.y));
window.overlay.on('wheel:release', (p) => {
  const chosen = wheelOf(p).release(p.x, p.y);
  if (!chosen) return;
  if (p.wheel === 'emote') {
    emote('self', localArt(chosen.key), chosen.x, chosen.y);
    window.overlay.reportEmote(chosen.key, chosen.x, chosen.y);
  } else {
    const def = pingById(chosen.key) ?? fallbackPing;
    ping(def, chosen.x, chosen.y);
    window.overlay.reportPing(def.id, chosen.x, chosen.y);
  }
});
window.overlay.on('wheel:cancel', () => {
  pingWheel.cancel();
  emoteWheel.cancel();
});
window.overlay.on('ping:spawn', (p) => ping(pingById(p.id) ?? fallbackPing, p.x, p.y, p.tag));
window.overlay.on('emote:spawn', (p) => emote(p.owner, p.art, p.x, p.y, p.tag));
window.overlay.on('emote:clear', (p) => stage.clear(p.owner));
window.overlay.on('toast:show', (t) => showToast(toastLayer, t.title, t.body));

/** Resolves with `label` when the image at `url` doesn't load. */
const probe = (url: string, label: string): Promise<string | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(null);
    img.onerror = () => resolve(label);
    img.src = url;
  });

/** Like probe for a file that is too big to load just to check it: the emote animations come to about 50 MB. */
async function probeHead(url: string, label: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    void res.body?.cancel(); // the headers are enough
    return res.ok ? null : label;
  } catch {
    return label;
  }
}

function checkImages(): Promise<string[]> {
  const pings = allTextureNames().map((name) => probe(textureUrl(name), `textures/${name}.png`));
  const emotes = allEmoteAssetFiles()
    .filter((file) => !file.endsWith('.ogg'))
    .map((file) => probeHead(`../${file}`, file));
  return Promise.all([...pings, ...emotes]).then((r) => r.filter((x): x is string => x !== null));
}

const soundEntries = [
  ...allSoundNames().map((name) => ({ key: name, url: soundUrl(name) })),
  ...EMOTE_CATALOG.filter((e) => e.hasSound).map((e) => ({ key: `emote:${e.slug}`, url: emoteSoundUrl(e.slug) })),
];
// About lists a missing file by its place in assets/ ("sounds/x.wav", "emotes/y.ogg"), not by the URL this page used.
const assetName = (url: string): string => url.replace(/^(?:\.{1,2}\/)+/, '');

void Promise.all([sounds.load(soundEntries), checkImages()]).then(([missingSounds, missingImages]) => {
  const missing = [...missingSounds.map(assetName), ...missingImages];
  if (missing.length > 0) window.overlay.reportMissingAssets(missing);
});
