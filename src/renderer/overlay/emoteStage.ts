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
  /** The object URL an animation plays from, once its bytes have arrived. */
  url: string | null;
  /** The moment a custom animation freezes on its still, when its loop ends before the emote's time is up. */
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

/** The emotes on this overlay: at most one per owner ('self', 'preview' or a room member's id), gone after EMOTE_DURATION_S — or, for a custom animation, after one loop of it plus its frozen hold. */
export class EmoteStage {
  private readonly live = new Map<string, Live>();
  /** An animation file's bytes, fetched once per URL: every spawn plays them from a fresh object URL. */
  private readonly files = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

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
      if (art.animated) this.showAnimation(owner, live, art);
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
   * A missing file (the asset check lists it in About) or one that arrives but can't be decoded: the placeholder plays
   * instead, for the emote's usual time. It replaces the sheet once, and not at all after the emote is gone.
   */
  private showBundled(live: Live, slug: string): void {
    const img = image('sheet');
    live.root.append(img);
    let swapped = false;
    const placeholder = (): void => {
      if (swapped || live.gone) return;
      swapped = true;
      img.replaceWith(envelope(bubble(), 0));
    };
    img.addEventListener('error', placeholder, { once: true });
    this.file(emoteAnimUrl(slug)).then(
      (data) => {
        if (live.gone) return;
        live.url = URL.createObjectURL(new Blob([data], { type: 'image/webp' }));
        img.src = live.url;
      },
      placeholder,
    );
  }

  /**
   * A custom animation stays up for one loop of its file plus a hold, frozen on the imported still — the loop's first
   * frame, which is what a well-looped gif's last frame looks like — so the goodbye never interrupts the animation and
   * the gif never replays its start. A file we can't fetch or time plays the shared URL for the default time instead.
   */
  private showAnimation(owner: string, live: Live, art: Extract<EmoteArt, { kind: 'custom' }>): void {
    const img = image();
    img.addEventListener('error', () => img.replaceWith(envelope(bubble(), 0)), { once: true });
    live.root.append(envelope(img, art.fx));
    this.file(art.url).then(
      (data) => {
        if (live.gone) return;
        live.url = URL.createObjectURL(new Blob([data], { type: sniffImage(data) === 'gif' ? 'image/gif' : 'image/webp' }));
        img.src = live.url;
        const loopMs = animationLoopMs(data);
        if (loopMs === null) return;
        const totalS = emoteDurationS(loopMs);
        this.retime(owner, live, totalS);
        const holdS = totalS - loopMs / 1000;
        if (holdS > 0.05) {
          live.freeze = setTimeout(() => {
            if (!live.gone) img.src = art.still;
          }, loopMs);
        }
      },
      () => {
        if (!live.gone) img.src = art.url;
      },
    );
  }

  /**
   * An animation file's bytes, fetched once per URL and fetched again after a failure. Every spawn plays them from a
   * fresh object URL, because Chromium gives images with the same URL one shared clock and a new emote should start
   * at frame 0.
   */
  private file(url: string): Promise<Uint8Array<ArrayBuffer>> {
    let file = this.files.get(url);
    if (!file) {
      file = this.fetchBlob(url).then((b) => b.arrayBuffer()).then((ab) => new Uint8Array(ab));
      this.files.set(url, file);
      const fetched = file;
      file.catch(() => {
        if (this.files.get(url) === fetched) this.files.delete(url); // try again next time
      });
    }
    return file;
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
