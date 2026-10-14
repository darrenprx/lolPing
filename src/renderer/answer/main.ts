import type { AnswerApi } from '../../preload/answer';
import { textureUrl } from '../../shared/pings';

declare global {
  interface Window {
    answer: AnswerApi;
  }
}

const root = document.getElementById('root') as HTMLElement;
const icon = document.getElementById('icon') as HTMLImageElement;
const title = document.getElementById('title') as HTMLElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;
const spinner = document.getElementById('spinner') as HTMLElement;
const text = document.getElementById('text') as HTMLElement;
const closeHint = document.getElementById('closeHint') as HTMLElement;
const countdown = document.getElementById('countdown') as HTMLElement;
const countdownBar = countdown.firstElementChild as HTMLElement;

icon.src = textureUrl('generic_ping');

let mode: 'fullscreen' | 'card' = 'fullscreen';
let lastSeconds = 10;
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

/** Whether the card should be counting down to its own close: a done answer, never an error. */
const countsDown = (): boolean => mode === 'card' && spinner.hidden && !text.hidden && text.className !== 'err';

window.answer.on('answer:state', (s) => {
  mode = s.mode;
  lastSeconds = s.cardSeconds;
  root.hidden = false;
  root.className = s.mode;
  title.textContent = s.title;
  spinner.hidden = !s.pending;
  text.hidden = s.pending;
  text.textContent = s.body;
  text.className = s.error ? 'err' : '';
  closeBtn.hidden = s.mode !== 'card';
  if (s.mode === 'fullscreen') {
    stopTimer();
    countdown.hidden = true;
    closeHint.textContent = s.pending ? '' : s.closeHint;
  } else if (countsDown()) {
    armCountdown(lastSeconds);
  } else {
    stopTimer();
    countdown.hidden = true;
    closeHint.textContent = '';
  }
});

// Fullscreen: any click on the backdrop closes. The card keeps its own ✕ and its timer.
root.addEventListener('mousedown', (e) => {
  if (mode === 'fullscreen') window.answer.close();
});
closeBtn.addEventListener('click', () => window.answer.close());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.answer.close();
});
// Hovering the card pauses the countdown; leaving restarts it with the full duration.
root.addEventListener('mouseenter', stopTimer);
root.addEventListener('mouseleave', () => {
  if (countsDown()) armCountdown(lastSeconds);
});
