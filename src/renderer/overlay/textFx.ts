import type { PingTag } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import type { RoomTextStyle } from '../../shared/settings';
import { DanmakuLanes, OwnerLimit, keepOnScreen, textDurationMs } from './roomTextLayout';

const MAX_LINES_PER_OWNER = 3;
/** 弹幕 lines move at this speed times the speed setting. */
const DANMAKU_SPEED_PX_S = 160;
/** A row is this much taller than its text: 34 px rows for the default 22 px text. */
const DANMAKU_LINE_RATIO = 34 / 22;

/** How 弹幕 lines look here: the text size in px and the speed as a multiple of 160 px/s. */
export interface DanmakuLook {
  sizePx: number;
  speed: number;
}
/** Space kept between a spot bubble and the display's edge. */
const SPOT_MARGIN_PX = 8;

export interface TextLine {
  text: string;
  x: number;
  y: number;
  /** 'self' or a room member: the line cap is per owner. */
  owner: string;
  style: RoomTextStyle;
  tag?: PingTag;
}

interface Shown {
  owner: string;
  root: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
}

const el = (className: string, text?: string): HTMLElement => {
  const e = document.createElement('div');
  e.className = className;
  if (text !== undefined) e.textContent = text; // never HTML: the text and the name come from another machine
  return e;
};

/** Room text on one display's overlay: spot bubbles and scrolling 弹幕 lines. */
export class TextStage {
  private readonly limit = new OwnerLimit(MAX_LINES_PER_OWNER);
  private readonly shown = new Map<number, Shown>();
  /** 弹幕 lines that have no lane yet, oldest first, with the width they were measured at. */
  private readonly waiting: Array<{ id: number; widthPx: number; heightPx: number }> = [];
  private lanes: DanmakuLanes | null = null;
  private laneCount = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private look: DanmakuLook = { sizePx: 22, speed: 1 };

  constructor(private readonly layer: HTMLElement, private readonly now: () => number = Date.now) {}

  /** Applies to lines that come after; the ones on screen keep their size and speed. */
  setDanmaku(look: DanmakuLook): void {
    this.look = { ...look };
  }

  private lineHeightPx(): number {
    return Math.round(this.look.sizePx * DANMAKU_LINE_RATIO);
  }

  spawn(line: TextLine): void {
    const id = this.nextId++;
    for (const old of this.limit.add(line.owner, id)) this.drop(old);
    if (line.style === 'danmaku') this.spawnDanmaku(id, line);
    else this.spawnSpot(id, line);
  }

  private spawnSpot(id: number, line: TextLine): void {
    const ms = textDurationMs(line.text);
    const root = el('text-pop');
    root.style.setProperty('--dur', `${ms}ms`);
    if (line.tag) root.append(this.nameOf('text-name', line.tag));
    root.append(el('text-body', line.text));
    this.layer.append(root);
    // The bubble is centred above the point, so near an edge it would be cut off. Its width depends on where it
    // sits (it shrinks to fit the space right of `left`), so measure at the point, move it in, and measure again.
    let at = { x: line.x, y: line.y };
    for (let pass = 0; pass < 2; pass++) {
      root.style.left = `${at.x}px`;
      root.style.top = `${at.y}px`;
      at = keepOnScreen(
        line, { width: root.offsetWidth, height: root.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }, SPOT_MARGIN_PX,
      );
    }
    root.style.left = `${at.x}px`;
    root.style.top = `${at.y}px`;
    this.shown.set(id, { owner: line.owner, root, timer: setTimeout(() => this.drop(id), ms) });
  }

  private spawnDanmaku(id: number, line: TextLine): void {
    const root = el('danmaku wait');
    if (line.tag) root.append(this.nameOf('danmaku-name', line.tag));
    root.append(el('danmaku-text', line.text));
    root.style.fontSize = `${this.look.sizePx}px`;
    root.style.lineHeight = `${this.lineHeightPx()}px`;
    root.style.left = `${window.innerWidth}px`;
    this.layer.append(root);
    this.shown.set(id, { owner: line.owner, root, timer: null });
    this.waiting.push({ id, widthPx: root.offsetWidth, heightPx: this.lineHeightPx() });
    this.pump();
  }

  private nameOf(className: string, tag: PingTag): HTMLElement {
    const name = el(className, tag.name);
    name.style.setProperty('--tag', tagColorCss(tag.color, tag.rgb));
    return name;
  }

  /** Starts waiting lines while there is a free lane, and comes back when the next one frees. */
  private pump(): void {
    if (this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    const speedPxS = DANMAKU_SPEED_PX_S * this.look.speed;
    for (let next = this.waiting[0]; next !== undefined; next = this.waiting[0]) {
      const lanes = this.lanesFor(window.innerHeight, next.heightPx);
      const lane = lanes.take(next.widthPx, speedPxS, window.innerWidth);
      if (lane === null) {
        this.pumpTimer = setTimeout(() => this.pump(), lanes.nextFreeMs(speedPxS, window.innerWidth) + 1);
        return;
      }
      this.waiting.shift();
      this.startDanmaku(next.id, next.widthPx, lane * next.heightPx, speedPxS);
    }
  }

  private startDanmaku(id: number, widthPx: number, topPx: number, speedPxS: number): void {
    const line = this.shown.get(id);
    if (!line) return;
    const travelPx = window.innerWidth + widthPx;
    const ms = (travelPx / speedPxS) * 1000;
    line.root.style.top = `${topPx}px`;
    line.root.style.setProperty('--travel', `-${travelPx}px`);
    line.root.style.setProperty('--dur', `${ms}ms`);
    line.root.classList.remove('wait');
    line.timer = setTimeout(() => this.drop(id), ms);
  }

  /** Takes a line down, whether it is on screen or still waiting for a lane. */
  private drop(id: number): void {
    const line = this.shown.get(id);
    if (!line) return;
    if (line.timer !== null) clearTimeout(line.timer);
    line.root.remove();
    this.shown.delete(id);
    this.limit.remove(line.owner, id);
    const waiting = this.waiting.findIndex((w) => w.id === id);
    if (waiting >= 0) this.waiting.splice(waiting, 1);
  }

  /** The 弹幕 rows: the top quarter of the display, one row per line height. Rebuilt if the display or the size changed. */
  private lanesFor(heightPx: number, lineHeightPx: number): DanmakuLanes {
    const count = Math.max(1, Math.floor(heightPx / 4 / lineHeightPx));
    if (this.lanes === null || count !== this.laneCount) {
      this.lanes = new DanmakuLanes(count, this.now);
      this.laneCount = count;
    }
    return this.lanes;
  }
}
