import { EMOTE_DURATION_S, emoteAnimUrl, emoteIconUrl, type EmoteArt } from '../../shared/emotes';
import type { PingTag } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import { bubble, emoteFxContent, envelope } from '../shared/emoteFx';

export interface EmoteOptions {
  /** How wide the emote's art appears. */
  sizePx: number;
  /** A room member's name under the emote. */
  tag?: PingTag;
  /** Stays on screen until `clear`, as a still once its animation has played (the teammate's, until it fades). */
  keep?: boolean;
}

/** A kept emote's envelope never reaches its goodbye: this is longer than anyone leaves lolPing running. */
const KEPT_DUR_S = 86_400;

interface Live {
  root: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  /** The object URL of an emote's animation, once its Blob has arrived. */
  url: string | null;
  gone: boolean;
  /** A kept bundled emote's change from its animation to its still, once the animation is over. */
  settle?: () => void;
}

const div = (cls: string): HTMLDivElement => {
  const d = document.createElement('div');
  d.className = cls;
  return d;
};

function image(cls = ''): HTMLImageElement {
  const el = document.createElement('img');
  if (cls) el.className = cls;
  el.alt = '';
  el.draggable = false;
  return el;
}

/** The emotes on this overlay: at most one per owner ('self', 'preview' or a room member's id), each gone after EMOTE_DURATION_S. */
export class EmoteStage {
  private readonly live = new Map<string, Live>();
  private readonly blobs = new Map<string, Promise<Blob>>();

  constructor(private readonly layer: HTMLElement, private readonly fetchBlob: (url: string) => Promise<Blob> = fetchImage) {}

  /** Shows `art` centred on (x, y), replacing the owner's emote if it has one on screen. */
  spawn(owner: string, art: EmoteArt, x: number, y: number, opts: EmoteOptions): void {
    this.clear(owner);
    const root = div('emote');
    if (owner === 'mate') root.dataset.owner = owner; // 'mate:fade' finds the teammate's marks by it, pings and emotes alike
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.setProperty('--size', `${opts.sizePx}px`);
    root.style.setProperty('--dur', `${opts.keep ? KEPT_DUR_S : EMOTE_DURATION_S}s`);
    const live: Live = {
      root, url: null, gone: false,
      timer: setTimeout(() => (opts.keep ? live.settle?.() : this.end(owner, live)), EMOTE_DURATION_S * 1000 + 150),
    };
    this.live.set(owner, live);

    if (art.kind === 'bundled') this.showBundled(live, art.slug, opts.keep === true);
    else if (art.kind === 'custom') {
      if (art.animated) this.showCustomAnimation(live, art);
      else root.append(emoteFxContent(art.fx, art.url));
    }
    else root.append(envelope(bubble(), 0));

    if (opts.tag) {
      const tag = div('tag');
      tag.textContent = opts.tag.name; // never HTML: the name comes from another machine
      tag.style.setProperty('--tag', tagColorCss(opts.tag.color, opts.tag.rgb));
      root.append(tag);
    }
    this.layer.append(root);
  }

  /** Removes the owner's emote at once, if it has one. */
  clear(owner: string): void {
    const live = this.live.get(owner);
    if (live) this.end(owner, live);
  }

  /** Each spawn gets a fresh clock, with no unbounded renderer cache of multi-megabyte originals. */
  private showCustomAnimation(live: Live, art: Extract<EmoteArt, { kind: 'custom' }>): void {
    const fallback = art.stillUrl ?? art.url.replace(/\.anim$/, '.webp');
    const content = emoteFxContent(art.fx, fallback);
    live.root.append(content);
    this.fetchBlob(art.url).then((blob) => {
      if (live.gone) return;
      live.url = URL.createObjectURL(blob);
      const animation = emoteFxContent(art.fx, live.url);
      const img = animation.querySelector('img');
      img?.addEventListener('error', () => {
        if (!live.gone) animation.replaceWith(emoteFxContent(art.fx, fallback));
      }, { once: true });
      content.replaceWith(animation);
    }, () => { /* The still is already visible when a cached original disappeared. */ });
  }

  /**
   * The baked animation plays once from frame 0, but Chromium gives images with the same URL one shared clock, so each
   * spawn gets its own object URL (the Blob is fetched once per emote).
   */
  private showBundled(live: Live, slug: string, keep: boolean): void {
    const img = image('sheet');
    live.root.append(img);
    // A missing file (the asset check lists it in About) or one that arrives but can't be decoded: the placeholder plays
    // instead, for the emote's usual time. It replaces the sheet once, and not at all after the emote is gone.
    let swapped = false;
    const placeholder = (): void => {
      if (swapped || live.gone) return;
      swapped = true;
      img.replaceWith(envelope(bubble(), 0));
    };
    img.addEventListener('error', placeholder, { once: true });
    // The baked animations play once and all but one (poro_snax) end on an empty frame, so a kept emote holds its
    // wheel icon after the animation instead.
    if (keep) {
      live.settle = () => {
        if (swapped || live.gone) return;
        swapped = true;
        img.className = 'still';
        img.src = emoteIconUrl(slug);
      };
    }
    this.blob(slug).then(
      (blob) => {
        if (live.gone || swapped) return; // a late blob must not bring the animation back over the still
        live.url = URL.createObjectURL(blob);
        img.src = live.url;
      },
      placeholder,
    );
  }

  private blob(slug: string): Promise<Blob> {
    let blob = this.blobs.get(slug);
    if (!blob) {
      blob = this.fetchBlob(emoteAnimUrl(slug));
      this.blobs.set(slug, blob);
      const fetched = blob;
      blob.catch(() => {
        if (this.blobs.get(slug) === fetched) this.blobs.delete(slug); // try again next time
      });
    }
    return blob;
  }

  private end(owner: string, live: Live): void {
    if (live.gone) return;
    live.gone = true;
    clearTimeout(live.timer);
    live.root.remove();
    if (live.url) URL.revokeObjectURL(live.url);
    if (this.live.get(owner) === live) this.live.delete(owner);
  }
}

async function fetchImage(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.blob();
}
