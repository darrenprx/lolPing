import { EMOTE_DURATION_S, emoteAnimUrl, type EmoteArt } from '../../shared/emotes';
import type { PingTag } from '../../shared/ipc';
import { TAG_COLORS } from '../../shared/roomColors';

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

/** What stands in for an emote whose files are missing. */
function bubble(): HTMLDivElement {
  const b = div('bubble');
  b.textContent = '?';
  return b;
}

/** The CSS envelope a custom image or the placeholder plays in: what the baked animation does for a bundled emote. */
function envelope(child: HTMLElement): HTMLDivElement {
  const fx = div('fx');
  fx.append(child);
  return fx;
}

async function fetchImage(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.blob();
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
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.setProperty('--size', `${opts.sizePx}px`);
    root.style.setProperty('--dur', `${EMOTE_DURATION_S}s`);
    const live: Live = {
      root, url: null, gone: false,
      timer: setTimeout(() => this.end(owner, live), EMOTE_DURATION_S * 1000 + 150),
    };
    this.live.set(owner, live);

    if (art.kind === 'bundled') this.showBundled(live, art.slug);
    else if (art.kind === 'custom') {
      const img = image();
      img.addEventListener('error', () => img.replaceWith(bubble()), { once: true });
      img.src = art.url;
      root.append(envelope(img));
    } else {
      root.append(envelope(bubble()));
    }

    if (opts.tag) {
      const tag = div('tag');
      tag.textContent = opts.tag.name; // never HTML: the name comes from another machine
      tag.style.setProperty('--tag', TAG_COLORS[opts.tag.color] ?? TAG_COLORS[0]);
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
      img.replaceWith(envelope(bubble()));
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
