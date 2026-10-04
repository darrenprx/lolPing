import {
  DEFAULT_CLICK_PING, TICK_SOUND, allSoundNames, allTextureNames, pingById, pingsFor, textureUrl, type PingDef,
} from '../../shared/pings';
import type { PingTag } from '../../shared/ipc';
import { DEFAULT_SETTINGS, overlaySettings, type OverlaySettings } from '../../shared/settings';
import { spawnPing } from './pingFx';
import { SoundBank } from './soundBank';
import { showToast } from './toast';
import { Wheel } from './wheel';

const pingLayer = document.getElementById('pings') as HTMLElement;
const toastLayer = document.getElementById('toasts') as HTMLElement;
const svg = document.getElementById('wheel') as unknown as SVGSVGElement;

const sounds = new SoundBank();
let settings: OverlaySettings = overlaySettings(DEFAULT_SETTINGS);
const [fallbackPing] = pingsFor([DEFAULT_CLICK_PING]);
const volume = (): number => (settings.muted ? 0 : settings.volume / 100);

const wheel = new Wheel(svg, () => {
  if (settings.tickSound) sounds.play(TICK_SOUND, volume() * 0.5);
});

function ping(def: PingDef, x: number, y: number, tag?: PingTag): void {
  spawnPing(pingLayer, def, x, y, { sizePx: settings.pingSizePx, durationS: settings.pingDurationS, tag });
  sounds.play(def.sound, volume());
}

window.overlay.on('overlay:settings', (s) => {
  settings = s;
  wheel.setPings(pingsFor(s.wheel));
});
window.overlay.on('wheel:open', (p) => wheel.open(p.x, p.y));
window.overlay.on('wheel:move', (p) => wheel.move(p.x, p.y));
window.overlay.on('wheel:release', (p) => {
  const chosen = wheel.release(p.x, p.y);
  if (!chosen) return;
  ping(chosen.def, chosen.x, chosen.y);
  window.overlay.reportPing(chosen.def.id, chosen.x, chosen.y);
});
window.overlay.on('wheel:cancel', () => wheel.cancel());
window.overlay.on('ping:spawn', (p) => ping(pingById(p.id) ?? fallbackPing, p.x, p.y, p.tag));
window.overlay.on('toast:show', (t) => showToast(toastLayer, t.title, t.body));

function checkTextures(): Promise<string[]> {
  return Promise.all(
    allTextureNames().map(
      (name) =>
        new Promise<string | null>((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve(null);
          probe.onerror = () => resolve(`textures/${name}.png`);
          probe.src = textureUrl(name);
        }),
    ),
  ).then((r) => r.filter((x): x is string => x !== null));
}

void Promise.all([sounds.load(allSoundNames()), checkTextures()]).then(([missingSounds, missingTextures]) => {
  const missing = [...missingSounds, ...missingTextures];
  if (missing.length > 0) window.overlay.reportMissingAssets(missing);
});
