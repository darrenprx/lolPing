import type { AnswerApi } from '../../preload/answer';
import type { AnswerState, AnswerTurn } from '../../shared/ipc';
import { textureUrl } from '../../shared/pings';
import { parseMarkdown, type MdBlock, type MdSpan } from './markdown';

declare global {
  interface Window {
    answer: AnswerApi;
  }
}

const root = document.getElementById('root') as HTMLElement;
const icon = document.getElementById('icon') as HTMLImageElement;
const title = document.getElementById('title') as HTMLElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;
const shot = document.getElementById('shot') as HTMLElement;
const thumb = document.getElementById('thumb') as HTMLImageElement;
const chat = document.getElementById('chat') as HTMLElement;
const input = document.getElementById('q') as HTMLInputElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const closeHint = document.getElementById('closeHint') as HTMLElement;
const countdown = document.getElementById('countdown') as HTMLElement;
const countdownBar = countdown.firstElementChild as HTMLElement;

icon.src = textureUrl('generic_ping');

let last: AnswerState | null = null;
let timer: number | null = null;

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/** Card mode only: close after `seconds`, paused while the pointer rests on the card. */
function armCountdown(seconds: number): void {
  stopTimer();
  countdown.hidden = false;
  countdownBar.style.transition = 'none';
  countdownBar.style.transform = 'scaleX(1)';
  void countdownBar.offsetWidth; // commit the reset before the shrink starts
  countdownBar.style.transition = `transform ${seconds}s linear`;
  countdownBar.style.transform = 'scaleX(0)';
  timer = window.setTimeout(() => window.answer.close(), seconds * 1000);
}

const mdSpan = (s: MdSpan): Node => {
  if (s.t === 'text' || s.t === 'link') return document.createTextNode(s.text);
  if (s.t === 'code') {
    const c = document.createElement('code');
    c.textContent = s.text;
    return c;
  }
  const el = document.createElement(s.t === 'bold' ? 'b' : 'i');
  for (const child of s.spans) el.append(mdSpan(child));
  return el;
};

const mdBlock = (b: MdBlock): HTMLElement => {
  const inline = (spans: MdSpan[]): HTMLElement => {
    const el = document.createElement('p');
    for (const s of spans) el.append(mdSpan(s));
    return el;
  };
  if (b.t === 'hr') return document.createElement('hr');
  if (b.t === 'code') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = b.text;
    pre.append(code);
    return pre;
  }
  if (b.t === 'heading') {
    const h = document.createElement(`h${Math.min(b.level, 6)}`);
    for (const s of b.spans) h.append(mdSpan(s));
    return h;
  }
  if (b.t === 'quote') {
    const q = document.createElement('blockquote');
    for (const spans of b.lines) q.append(inline(spans));
    return q;
  }
  if (b.t === 'list') {
    const l = document.createElement(b.ordered ? 'ol' : 'ul');
    for (const spans of b.items) {
      const li = document.createElement('li');
      for (const s of spans) li.append(mdSpan(s));
      l.append(li);
    }
    return l;
  }
  return inline(b.spans);
};

const working = (): HTMLElement => {
  const d = document.createElement('div');
  d.className = 'working';
  d.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  return d;
};

function renderTurn(turn: AnswerTurn): void {
  const q = document.createElement('div');
  q.className = 'turn-user';
  const bubble = document.createElement('span');
  bubble.textContent = turn.q;
  q.append(bubble);
  chat.append(q);

  const a = document.createElement('div');
  a.className = turn.error ? 'turn-ai err' : 'turn-ai';
  if (turn.pending) a.append(working());
  else for (const block of parseMarkdown(turn.a)) a.append(mdBlock(block));
  chat.append(a);
}

function render(state: AnswerState): void {
  root.hidden = false;
  root.className = state.mode;
  document.documentElement.style.setProperty('--fs', `${state.fontSize}px`);
  title.textContent = state.title;
  closeBtn.title = 'Esc';
  sendBtn.title = state.askPlaceholder;
  thumb.src = state.thumbnail;
  shot.hidden = state.thumbnail === '';
  closeHint.textContent = state.closeHint;

  stopTimer();
  chat.replaceChildren();
  for (const turn of state.turns) renderTurn(turn);
  chat.scrollTop = chat.scrollHeight;

  const done = state.turns.length > 0 && !state.turns[state.turns.length - 1].pending;
  const failed = state.turns.some((t) => t.error);
  input.disabled = !done;
  sendBtn.disabled = !done;
  sendBtn.textContent = state.turns[state.turns.length - 1]?.pending ? '' : '➤';
  if (state.mode === 'fullscreen') {
    countdown.hidden = true;
    closeHint.textContent = done ? state.closeHint : '';
  } else if (done && !failed) {
    armCountdown(state.cardSeconds);
  } else {
    countdown.hidden = true;
    closeHint.textContent = '';
    if (done && failed) input.disabled = false, sendBtn.disabled = false; // an error invites a retry
  }
  if (!input.disabled) input.focus({ preventScroll: true });
}

window.answer.on('answer:state', (s) => {
  last = s;
  render(s);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !input.disabled && input.value.trim() !== '') {
    window.answer.ask(input.value.trim());
    input.value = '';
  }
});
sendBtn.addEventListener('click', () => {
  if (!input.disabled && input.value.trim() !== '') {
    window.answer.ask(input.value.trim());
    input.value = '';
  }
});
closeBtn.addEventListener('click', () => window.answer.close());
window.addEventListener('keydown', (e) => {
  // Esc closes, unless the user is mid-sentence in the input: the first Esc leaves the input alone.
  if (e.key === 'Escape' && !(document.activeElement === input && input.value !== '')) window.answer.close();
});
// Hovering the card pauses the countdown; leaving restarts it with the full duration.
root.addEventListener('mouseenter', stopTimer);
root.addEventListener('mouseleave', () => {
  if (last && last.mode === 'card' && last.turns.length > 0) {
    const turn = last.turns[last.turns.length - 1];
    if (!turn.pending && !turn.error) armCountdown(last.cardSeconds);
  }
});
