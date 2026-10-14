import type { CaptureApi } from '../../preload/capture';
import type { CaptureRect } from '../../shared/ipc';

declare global {
  interface Window {
    capture: CaptureApi;
  }
}

const hint = document.getElementById('hint') as HTMLElement;
const shade = document.getElementById('shade') as HTMLElement;
const rectEl = document.getElementById('rect') as HTMLElement;
const toolbar = document.getElementById('toolbar') as HTMLElement;
const okBtn = document.getElementById('ok') as HTMLButtonElement;
const noBtn = document.getElementById('no') as HTMLButtonElement;

/** Small drags are a click, not a selection: they shoot the whole screen. */
const CLICK_PX = 5;

let down: { x: number; y: number } | null = null;
let rect: CaptureRect | null = null;

const bounds = (): { w: number; h: number } => ({ w: window.innerWidth, h: window.innerHeight });

/** A clamped, right-way-round area between two points. */
const between = (a: { x: number; y: number }, b: { x: number; y: number }): CaptureRect => {
  const { w, h } = bounds();
  const x1 = Math.min(Math.max(a.x, 0), w);
  const y1 = Math.min(Math.max(a.y, 0), h);
  const x2 = Math.min(Math.max(b.x, 0), w);
  const y2 = Math.min(Math.max(b.y, 0), h);
  return { x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)), width: Math.round(Math.abs(x2 - x1)), height: Math.round(Math.abs(y2 - y1)) };
};

function drawRect(r: CaptureRect): void {
  rect = r;
  rectEl.hidden = false;
  shade.hidden = true; // the rect's own shadow takes over the darkening
  rectEl.style.left = `${r.x}px`;
  rectEl.style.top = `${r.y}px`;
  rectEl.style.width = `${r.width}px`;
  rectEl.style.height = `${r.height}px`;
}

function showToolbar(): void {
  toolbar.hidden = false;
  okBtn.focus({ preventScroll: true }); // Enter then confirms, without moving the crosshair work
}

function reset(): void {
  down = null;
  rect = null;
  rectEl.hidden = true;
  toolbar.hidden = true;
  shade.hidden = false;
}

function confirm(r: CaptureRect): void {
  if (r.width < 2 || r.height < 2) return;
  window.capture.confirm(r);
}

function cancel(): void {
  window.capture.cancel();
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target === okBtn || e.target === noBtn) return;
  reset();
  down = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mousemove', (e) => {
  if (!down) return;
  drawRect(between(down, { x: e.clientX, y: e.clientY }));
  if (toolbar.hidden === false) toolbar.hidden = true;
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !down) return;
  const r = between(down, { x: e.clientX, y: e.clientY });
  down = null;
  // A click rather than a drag: the whole display is the area, confirmed at once like WeChat's does.
  if (r.width < CLICK_PX || r.height < CLICK_PX) {
    const { w, h } = bounds();
    confirm({ x: 0, y: 0, width: w, height: h });
    return;
  }
  drawRect(r);
  showToolbar();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
  else if (e.key === 'Enter' && rect && rect.width >= 2 && rect.height >= 2) confirm(rect);
});

okBtn.addEventListener('click', () => {
  if (rect) confirm(rect);
});
noBtn.addEventListener('click', cancel);

window.capture.on('capture:begin', ({ hint: text, confirm: ok, cancel: no }) => {
  hint.textContent = text;
  okBtn.title = ok;
  noBtn.title = no;
  hint.hidden = false;
  shade.hidden = false;
});
