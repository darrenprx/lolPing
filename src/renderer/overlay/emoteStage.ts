import { EMOTE_DURATION_S, emoteAnimUrl, emoteDurationS, type EmoteArt } from '../../shared/emotes';
import { animationLoopMs, sniffImage } from '../../shared/imageSniff';
import type { PingTag } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import { bubble, emoteFxContent, envelope } from '../shared/emoteFx';

export interface EmoteOptions {
  /** How wide the emote's art appears. */
  sizePx: number;
  /** A room member's name under the emote. */
  tag?: PingTag;
}

interface Live {
  root: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  /** The object URL of a bundled emote's image, once its Blob has arrived. */
  url: string | null;
  /** The moment an animation freezes on the still, when its loop ends before the emote's time is up. */
  freeze: ReturnType<typeof setTimeout> | null;
  gone: boolean;
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

/** The emotes on this overlay: at most one per owner ('self', 'preview' or a room member's id), gone after EMOTE_DURATION_S — or, for a custom animation, after one loop of it. */
export class EmoteStage {
  private readonly live = new Map<string, Live>();
  private readonly blobs = new Map<string, Promise<Blob>>();
  private readonly anims = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

  constructor(private readonly layer: HTMLElement, private readonly fetchBlob: (url: string) => Promise<Blob> = fetchImage) {}

  /** Shows `art` centred on (x, y), replacing the owner's emote if it has one on screen. */
  spawn(owner: string, art: EmoteArt, x: number, y: number, opts: EmoteOptions): void {
    this.clear(owner);
    const root = div('emote');
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.setProperty('--size', `${opts.sizePx}px`);
    root.style.setProperty('--dur', `${EMOTE_DURATION_S}s`);
    const live: Live = {
      root, url: null, freeze: null, gone: false,
      timer: setTimeout(() => this.end(owner, live), EMOTE_DURATION_S * 1000 + 150),
    };
    this.live.set(owner, live);

    if (art.kind === 'bundled') this.showBundled(live, art.slug);
    else if (art.kind === 'custom') {
      if (art.animated) this.showCustomAnim(owner, live, art.fx, art.url, art.still);
      else root.append(emoteFxContent(art.fx, art.url));
    } else root.append(envelope(bubble(), 0));

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

  /**
   * The baked animation plays once from frame 0, but Chromium gives images with the same URL one shared clock, so each
   * spawn gets its own object URL (the Blob is fetched once per emote).
   */
  private showBundled(live: Live, slug: string): void {
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
    this.blob(slug).then(
      (blob) => {
        if (live.gone) return;
        live.url = URL.createObjectURL(blob);
        img.src = live.url;
      },
      placeholder,
    );
  }

  /**
   * A custom animation: the image plays from its own object URL per spawn (Chromium gives images with the same URL one
   * shared clock, as for a bundled emote), and the emote stays up for one loop of the file plus a hold — capped at the
   * default, never shorter than its effect needs. The hold is frozen on the imported still, so the goodbye never
   * interrupts the animation and the gif never replays its start. A file we can't fetch or time plays the shared URL
   * for the default time instead.
   */
  private showCustomAnim(owner: string, live: Live, variant: number, url: string, still: string): void {
    const img = image();
    img.addEventListener('error', () => img.replaceWith(envelope(bubble(), 0)), { once: true });
    live.root.append(envelope(img, variant));
    this.anim(url).then(
      (data) => {
        if (live.gone) return;
        live.url = URL.createObjectURL(new Blob([data], { type: sniffImage(data) === 'gif' ? 'image/gif' : 'image/webp' }));
        img.src = live.url;
        const loopMs = animationLoopMs(data);
        if (loopMs === null) return;
        const totalS = emoteDurationS(loopMs);
        this.retime(owner, live, totalS);
        // For a loop that closes well, the still (its first frame) is what the last frame looks like, so the swap reads as freezing.
        const holdS = totalS - loopMs / 1000;
        if (holdS > 0.05) {
          live.freeze = setTimeout(() => {
            if (!live.gone) img.src = still;
          }, loopMs);
        }
      },
      () => {
        if (!live.gone) img.src = url;
      },
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

  /** An animation's bytes, fetched once per URL: they carry the object URL each spawn plays from and its loop time. */
  private anim(url: string): Promise<Uint8Array<ArrayBuffer>> {
    let anim = this.anims.get(url);
    if (!anim) {
      anim = this.fetchBlob(url).then((b) => b.arrayBuffer()).then((ab) => new Uint8Array(ab));
      this.anims.set(url, anim);
      const fetched = anim;
      anim.catch(() => {
        if (this.anims.get(url) === fetched) this.anims.delete(url); // try again next time
      });
    }
    return anim;
  }

  /** Moves an emote's goodbye, and the timer that removes it, to `durS` after it appeared. */
  private retime(owner: string, live: Live, durS: number): void {
    if (live.gone) return;
    live.root.style.setProperty('--dur', `${durS}s`);
    clearTimeout(live.timer);
    live.timer = setTimeout(() => this.end(owner, live), durS * 1000 + 150);
  }

  private end(owner: string, live: Live): void {
    if (live.gone) return;
    live.gone = true;
    clearTimeout(live.timer);
    if (live.freeze) clearTimeout(live.freeze);
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
