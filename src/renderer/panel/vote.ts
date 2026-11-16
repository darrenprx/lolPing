import { strings, type Strings } from '../../shared/i18n';
import type { PanelAction, PanelState } from '../../shared/ipc';
import type { RoomMember } from '../../shared/room';
import { VOTE_MS, type VoteView } from '../../shared/voteTally';

export interface VoteBox {
  peer: string;
  name: string;
  answer: 'yes' | 'no' | 'none';
}

/** One box per voter, in the order the vote fixed them. A voter who has left the room has no name any more. */
export function voteBoxes(v: VoteView, members: readonly RoomMember[]): VoteBox[] {
  return v.voters.map((peer) => {
    const ballot = v.ballots[peer];
    return { peer, name: members.find((m) => m.peer === peer)?.name ?? '', answer: ballot === undefined ? 'none' : ballot ? 'yes' : 'no' };
  });
}

/** The share of the vote's time that is left, 1 at the start and 0 at the end. */
export function voteLeft(v: VoteView, now: number): number {
  return Math.min(1, Math.max(0, (v.endsAt - now) / VOTE_MS[v.kind]));
}

/** Whether the buttons work: we are a voter who hasn't answered, and the vote is neither over nor out of time. */
export function canAnswer(v: VoteView, me: string | undefined, over: boolean, now: number): boolean {
  return me !== undefined && !over && now < v.endsAt && v.voters.includes(me) && !(me in v.ballots);
}

/** The surrender widget's bottom line once there is nothing to press: what we answered, or that the vote is over. */
export function voteStatus(mine: boolean | undefined, over: boolean, t: Strings): string | null {
  if (mine !== undefined) return mine ? t.voteYouYes : t.voteYouNo;
  return over ? t.voteEnded : null;
}

export function voteTitle(v: VoteView, members: readonly RoomMember[], t: Strings): string {
  if (v.kind === 'ff') return t.voteTitleFf;
  if (v.kind === 'ready') return t.voteTitleReady;
  return t.voteTitleKick(members.find((m) => m.peer === v.target)?.name ?? '?');
}

const MARK = { yes: '✓', no: '✗' } as const;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One mark per voter: the surrender widget's bar segments. */
function marks(className: string, boxes: readonly VoteBox[]): HTMLElement {
  const row = el('div', className);
  for (const b of boxes) {
    const mark = el('span', b.answer);
    mark.title = b.name;
    row.append(mark);
  }
  return row;
}

/** What the countdown moves: set on every draw, updated by `tick`. */
let countdown: { vote: VoteView; over: boolean; bar: HTMLElement } | null = null;

let ticking = false;

function tick(): void {
  if (!countdown) {
    ticking = false;
    return;
  }
  const { vote, over, bar } = countdown;
  bar.style.transform = `scaleX(${voteLeft(vote, Date.now())})`;
  if (over) ticking = false; // drawn once more, now that the result is in
  else requestAnimationFrame(tick);
}

/** Draws a surrender or kick vote into `root` as League's in-game surrender widget. The ready check is `readyCheck.ts`. */
export function renderVote(root: HTMLElement, state: PanelState, act: (a: PanelAction) => void): void {
  const v = state.vote;
  if (!v) {
    root.replaceChildren();
    countdown = null;
    return;
  }
  const t = strings(state.lang);
  const members = state.room.members;
  const me = members.find((m) => m.self)?.peer;
  const mine = me === undefined ? undefined : v.ballots[me];
  const answerable = canAnswer(v, me, state.voteOver, Date.now());

  const answerButton = (yes: boolean, className: string, label: string, name: string): HTMLButtonElement => {
    const b = el('button', className, label);
    b.type = 'button';
    b.setAttribute('aria-label', name);
    b.disabled = !answerable;
    b.addEventListener('click', () => act({ t: 'ballot', yes }));
    return b;
  };

  const card = el('section', 'vote surrender');
  const bar = el('div', 'bar');
  const track = el('div', 'track');
  track.append(bar);
  const foot = el('div', 'foot');
  const status = voteStatus(mine, state.voteOver, t);
  if (status === null) foot.append(answerButton(true, 'yes', MARK.yes, t.voteYes), answerButton(false, 'no', MARK.no, t.voteNo));
  else foot.append(el('span', 'said', status));
  card.append(el('h1', 'title', voteTitle(v, members, t)));
  if (v.topic) {
    const topic = el('p', 'topic', v.topic);
    topic.title = v.topic; // cut off with an ellipsis when long: the whole line shows on hover
    card.append(topic);
  }
  card.append(marks('segments', voteBoxes(v, members)), track, foot);
  root.replaceChildren(card);
  countdown = { vote: v, over: state.voteOver, bar };
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(tick);
  }
}
