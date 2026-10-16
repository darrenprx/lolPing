import { EMOTE_CATALOG } from '../../shared/emoteCatalog';
import {
  CUSTOM_EMOTE_URL, allEmoteAssetFiles, catalogEmote, customAnimUrl, customHash, customSoundUrl, customStillUrl, emoteSoundUrl,
  isBundledEmote,
  type EmoteArt, type EmoteRef,
} from '../../shared/emotes';
import {
  DEFAULT_CLICK_PING, TICK_SOUND, allSoundNames, allTextureNames, pingById, pingsFor, soundUrl, textureUrl, type PingDef,
} from '../../shared/pings';
import type { PingTag } from '../../shared/ipc';
import type { WheelKind } from '../../shared/protocol';
import { DEFAULT_SETTINGS, overlaySettings, soundLevel, type OverlaySettings } from '../../shared/settings';
import '../shared/emoteFx.css';
import { EmoteStage } from './emoteStage';
import { spawnPing } from './pingFx';
import { SoundBank } from './soundBank';
import { showToast } from './toast';
import { TextStage } from './textFx';
import { Wheel } from './wheel';
import { centerIcons, emoteItem, pingItem } from './wheelItems';

const pingLayer = document.getElementById('pings') as HTMLElement;
const toastLayer = document.getElementById('toasts') as HTMLElement;
const textLayer = document.getElementById('texts') as HTMLElement;
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
const texts = new TextStage(textLayer);
let settings: OverlaySettings = overlaySettings(DEFAULT_SETTINGS);
const [fallbackPing] = pingsFor([DEFAULT_CLICK_PING]);
const volume = (): number => soundLevel(settings);

const tick = (): void => {
  if (settings.tickSound) sounds.play(TICK_SOUND, volume() * 0.5);
};
const centers = centerIcons(settings);
const pingWheel = new Wheel(pingSvg, 'PING', centers.ping, tick);
const emoteWheel = new Wheel(emoteSvg, 'EMOTE', centers.emote, tick);

/** This machine's own emotes: the settings know what an imported one looks like, whether it moves and has a sound. */
function localArt(ref: EmoteRef): EmoteArt {
  if (isBundledEmote(ref)) return { kind: 'bundled', slug: ref };
  const custom = settings.customEmotes.find((c) => c.id === ref);
  if (!custom) return { kind: 'placeholder' };
  const hash = customHash(ref);
  const sound = custom.sound ? { sound: customSoundUrl(hash) } : {};
  return { kind: 'custom', url: custom.animated ? customAnimUrl(hash) : customStillUrl(hash), still: customStillUrl(hash), animated: custom.animated, ...sound, fx: custom.fx ?? 0 };
}

/** Our newest ping on this display while "Keep my last ping on screen" is on. */
let keptPing: HTMLElement | null = null;

function dropKeptPing(): void {
  keptPing?.remove();
  keptPing = null;
}

function applySettings(s: OverlaySettings): void {
  settings = s;
  sounds.forget(CUSTOM_EMOTE_URL); // an imported emote's sound may have been replaced: load it again when it next plays
  if (!s.keepLastPing) dropKeptPing();
  pingWheel.setSize(s.wheelSizePx);
  emoteWheel.setSize(s.wheelSizePx);
  pingWheel.setItems(pingsFor(s.wheel).map(pingItem));
  emoteWheel.setItems(s.emoteWheel.map((ref) => emoteItem(ref, s.customEmotes)));
  const { ping, emote } = centerIcons(s);
  pingWheel.setCenterIcon(ping);
  emoteWheel.setCenterIcon(emote);
}
applySettings(settings);

function ping(def: PingDef, x: number, y: number, tag?: PingTag, keep = false): void {
  if (keep) dropKeptPing();
  const el = spawnPing(pingLayer, def, x, y, { sizePx: settings.pingSizePx, durationS: settings.pingDurationS, tag, keep });
  if (keep) keptPing = el;
  sounds.play(def.sound, volume());
}

function emote(owner: string, art: EmoteArt, x: number, y: number, tag?: PingTag): void {
  stage.spawn(owner, art, x, y, { sizePx: settings.emoteSizePx, tag });
  if (!settings.emoteSound) return;
  if (art.kind === 'bundled' && catalogEmote(art.slug)?.hasSound) sounds.play(`emote:${art.slug}`, volume());
  if (art.kind === 'custom' && art.sound) void sounds.playUrl(art.sound, volume());
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
    ping(def, chosen.x, chosen.y, undefined, settings.keepLastPing);
    window.overlay.reportPing(def.id, chosen.x, chosen.y);
  }
});
window.overlay.on('wheel:cancel', () => {
  pingWheel.cancel();
  emoteWheel.cancel();
});
window.overlay.on('ping:spawn', (p) => ping(pingById(p.id) ?? fallbackPing, p.x, p.y, p.tag, p.keep === true));
window.overlay.on('ping:unkeep', dropKeptPing);
window.overlay.on('emote:spawn', (p) => emote(p.owner, p.art, p.x, p.y, p.tag));
window.overlay.on('emote:clear', (p) => stage.clear(p.owner));
window.overlay.on('toast:show', (t) => showToast(toastLayer, t.title, t.body));
window.overlay.on('text:spawn', (t) => texts.spawn(t));

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

// The same startup warm the sounds and sheets get: without it, the first ornamented emote pays for the glow
// sprites' decode and shader compile mid-gesture.

void Promise.all([sounds.load(soundEntries), checkImages()]).then(([missingSounds, missingImages]) => {
  const missing = [...missingSounds.map(assetName), ...missingImages];
  if (missing.length > 0) window.overlay.reportMissingAssets(missing);
});
