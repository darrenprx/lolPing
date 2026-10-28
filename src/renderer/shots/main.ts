import { strings } from '../../shared/i18n';
import type { ShotApi, ShotViewState } from '../../shared/ipc';
import './shots.css';

declare global { interface Window { shotApi: ShotApi } }
const root = document.getElementById('root');
if (!root) throw new Error('missing root');
let state: ShotViewState | null = null;
let selected = 0;
let zoom: number | null = null;
let activeKey = '';
let previous: ShotViewState | null = null;

const button = (label: string, title: string, run: () => void): HTMLButtonElement => {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title;
  b.setAttribute('aria-label', title); b.onclick = run; return b;
};

function draw(): void {
  if (!state || !root) return;
  const t = strings(state.lang).shots;
  document.documentElement.lang = state.lang;
  document.body.className = state.view;
  root.replaceChildren();
  selected = Math.min(selected, Math.max(0, state.images.length - 1));
  const image = state.images[selected];
  const header = document.createElement('header');
  const sender = document.createElement('strong'); sender.textContent = state.name;
  const caption = document.createElement('span');
  caption.textContent = image ? `${t.screen(image.meta.d)} · ${t.count(Math.max(0, ...state.images.flatMap((i) => i.meta.marks.map((m) => m.n))))}` : t.ready;
  header.append(sender, caption, button('×', t.close, () => window.shotApi.act('close')));
  root.append(header);
  const viewport = document.createElement('div'); viewport.className = 'viewport';
  if (image?.data) {
    const frame = document.createElement('div'); frame.className = 'frame';
    const img = document.createElement('img'); img.src = image.data; img.alt = t.screen(image.meta.d); img.draggable = false;
    img.onerror = () => { viewport.textContent = t.capture; };
    frame.style.aspectRatio = `${image.meta.w} / ${image.meta.h}`;
    if (state.view === 'viewer' && zoom !== null) {
      frame.style.width = `${image.meta.w * zoom}px`;
      frame.style.flexShrink = '0';
    } else {
      viewport.classList.toggle('fit', zoom === null);
      frame.style.width = '100%'; frame.style.maxHeight = '100%';
    }
    frame.append(img);
    for (const m of image.meta.marks) {
      const dot = document.createElement('span'); dot.className = 'mark'; dot.textContent = String(m.n);
      dot.style.left = `${m.x * 100}%`; dot.style.top = `${m.y * 100}%`;
      frame.append(dot);
    }
    viewport.append(frame);
    requestAnimationFrame(() => {
      const width = state?.view === 'viewer' && zoom !== null ? image.meta.w * zoom
        : Math.min(viewport.clientWidth, viewport.clientHeight * image.meta.w / image.meta.h);
      frame.style.width = `${width}px`;
      frame.style.height = `${width * image.meta.h / image.meta.w}px`;
    });
    if (state.view === 'card') {
      viewport.classList.add('clickable'); viewport.title = t.open;
      viewport.onclick = () => window.shotApi.act('open');
    } else {
      viewport.onwheel = (e) => {
        e.preventDefault(); zoom = Math.max(0.1, Math.min(8, (zoom ?? viewport.clientWidth / image.meta.w) * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
        const x = viewport.scrollLeft, y = viewport.scrollTop;
        draw(); const next = root?.querySelector('.viewport'); if (next) { next.scrollLeft = x; next.scrollTop = y; }
      };
      let drag: { x: number; y: number; left: number; top: number } | null = null;
      viewport.onpointerdown = (e) => {
        if (e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        viewport.setPointerCapture(e.pointerId);
      };
      viewport.onpointermove = (e) => {
        if (drag) { viewport.scrollLeft = drag.left + drag.x - e.clientX; viewport.scrollTop = drag.top + drag.y - e.clientY; }
      };
      viewport.onpointerup = () => { drag = null; };
      viewport.onpointercancel = () => { drag = null; };
    }
  } else {
    const p = document.createElement('p');
    p.textContent = image?.status === 'capture' ? t.capture : image?.status === 'large' ? t.large
      : image?.status === 'timeout' ? t.timeout : t.loading;
    viewport.append(p);
  }
  root.append(viewport);
  const footer = document.createElement('footer');
  if (state.images.length > 1) {
    footer.append(button('‹', t.previous, () => { selected = (selected + (state?.images.length ?? 1) - 1) % (state?.images.length ?? 1); zoom = null; draw(); }));
    const page = document.createElement('span'); page.textContent = `${selected + 1} / ${state.images.length}`; footer.append(page);
    footer.append(button('›', t.next, () => { selected = (selected + 1) % (state?.images.length ?? 1); zoom = null; draw(); }));
  }
  if (state.view === 'viewer') {
    footer.append(button(t.fit, t.fit, () => { zoom = null; draw(); }), button(t.actual, t.actual, () => { zoom = 1; draw(); }));
    const value = document.createElement('span'); value.textContent = zoom === null ? t.fit : `${Math.round(zoom * 100)}%`; footer.append(value);
  } else {
    const hint = document.createElement('span'); hint.textContent = t.open; hint.className = 'hint'; footer.append(hint);
  }
  if (image?.data && image.status !== 'ready') {
    const status = document.createElement('span');
    status.textContent = image.status === 'loading' ? t.loading : image.status === 'timeout' ? t.timeout
      : image.status === 'large' ? t.large : t.capture;
    footer.prepend(status);
  }
  root.append(footer);
}

window.shotApi.on((s) => {
  previous = state;
  state = s;
  if (activeKey !== s.key) { activeKey = s.key; selected = 0; zoom = null; }
  if (previous && previous.key === s.key && s.view === 'viewer') {
    // Keep the user's selected screen and zoom while a later crop arrives.
    selected = Math.min(selected, s.images.length - 1);
  }
  draw();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.shotApi.act('close'); });
document.documentElement.addEventListener('mouseenter', () => window.shotApi.act('enter'));
document.documentElement.addEventListener('mouseleave', () => window.shotApi.act('leave'));
