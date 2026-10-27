import type { PingTag } from '../../shared/ipc';
import { FALLBACK_TEXTURE, textureUrl, type PingDef } from '../../shared/pings';
import { tagColorCss } from '../../shared/roomColors';

/** Safety ceiling: past this many pings on screen the oldest go early, so a ping flood can't bog the overlay down. */
export const MAX_PINGS = 60;
const expiry = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function removePing(ping: Element): void {
  clearTimeout(expiry.get(ping));
  expiry.delete(ping);
  ping.remove();
}

export interface PingFxOptions {
  sizePx: number;
  durationS: number;
  /** A room member's name under the ping. */
  tag?: PingTag;
  /** Stays after its animation, until the caller removes it. */
  keep?: boolean;
  /** 'mate': the teammate's, which 'mate:clear' and 'mate:fade' find by its data-owner. */
  owner?: 'mate';
  /** The teammate's words for this spot, next to the ping. */
  label?: string;
  /** Animated dots on the tag: the teammate is still thinking. */
  thinking?: boolean;
  /** Only the tag (and label): no ground, rings or art. */
  tagOnly?: boolean;
}

function img(name: string, cls = ''): HTMLImageElement {
  const el = document.createElement('img');
  if (cls) el.className = cls;
  el.src = textureUrl(name);
  el.onerror = () => {
    el.onerror = null;
    el.src = textureUrl(FALLBACK_TEXTURE);
  };
  return el;
}

const div = (cls: string): HTMLDivElement => {
  const d = document.createElement('div');
  d.className = cls;
  return d;
};

/** Adds one animated ping at (x, y) and removes it when its animation ends, unless `opts.keep`. Returns its element. */
export function spawnPing(layer: HTMLElement, def: PingDef, x: number, y: number, opts: PingFxOptions): HTMLElement {
  const root = div(['ping', opts.keep ? 'kept' : '', opts.tagOnly ? 'tag-only' : ''].filter(Boolean).join(' '));
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  root.style.setProperty('--c', def.color);
  root.style.setProperty('--size', `${opts.sizePx}px`);
  root.style.setProperty('--dur', `${opts.durationS}s`);
  if (opts.owner) root.dataset.owner = opts.owner;
  if (!opts.tagOnly) {
    root.append(div('ground'), div('ring'), div('ring r2'), div('ring r3'));
    const art = div('art');
    if (def.art.length === 2) {
      const clash = div('clash');
      clash.append(img(def.art[0], 'a1'), img(def.art[1], 'a2'));
      art.append(clash, div('flash'));
    } else {
      const pop = div('pop');
      pop.append(img(def.art[0]));
      art.append(pop);
    }
    root.append(art);
  }
  if (opts.label) {
    const label = div('label');
    label.textContent = opts.label; // never HTML: the words come from a model
    root.append(label);
  }
  if (opts.tag) {
    const tag = div(opts.thinking ? 'tag dots' : 'tag');
    tag.textContent = opts.tag.name; // never HTML: the name comes from another machine
    tag.style.setProperty('--tag', tagColorCss(opts.tag.color, opts.tag.rgb));
    root.append(tag);
  }
  while (layer.childElementCount >= MAX_PINGS && layer.firstElementChild) removePing(layer.firstElementChild);
  layer.append(root);
  if (!opts.keep) expiry.set(root, setTimeout(() => removePing(root), opts.durationS * 1000 + 150));
  return root;
}
