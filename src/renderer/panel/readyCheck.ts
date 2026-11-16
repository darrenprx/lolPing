import { strings, type Strings } from '../../shared/i18n';
import type { PanelAction, PanelState } from '../../shared/ipc';
import type { RoomMember } from '../../shared/room';
import type { VoteView } from '../../shared/voteTally';
import { canAnswer, el, voteBoxes, voteTitle } from './vote';

/** What the client's ready check is showing: the countdown, our answer, or a vote that ended before we answered. */
export type ReadyPhase = 'countdown' | 'accepted' | 'declined' | 'ended';

export function readyPhase(mine: boolean | undefined, over: boolean): ReadyPhase {
  if (mine !== undefined) return mine ? 'accepted' : 'declined';
  return over ? 'ended' : 'countdown';
}

/**
 * The countdown video's speed, so it reaches its end when the vote does. The client does the same with its 10.7 s
 * video; an odd answer (no time left, a video not loaded yet) plays at normal speed.
 */
export function countdownRate(duration: number, currentTime: number, secondsLeft: number): number {
  const rate = (duration - currentTime) / secondsLeft;
  return Number.isFinite(rate) && rate > 0.0625 ? rate : 1;
}

/** The line under the title while counting down: who started it, and what for when they said. */
export function readyDetails(v: VoteView, members: readonly RoomMember[], t: Strings): string {
  const starter = members.find((m) => m.peer === v.starter)?.name;
  if (v.topic) return starter ? t.voteTopicBy(starter, v.topic) : v.topic;
  return starter ? t.voteStartedBy(starter) : '';
}

export type ReadySound = 'intro' | 'countdown' | 'acceptedLoop';

/**
 * Which sounds start and which fade out when the card moves to `to` (`from` is null for a card just shown). As in the
 * client: match found and the countdown when it appears, the accepted loop in place of the countdown once we accept,
 * and silence once we decline or the vote ends without us.
 */
export function readySounds(from: ReadyPhase | null, to: ReadyPhase): { play: ReadySound[]; fade: ReadySound[] } {
  const play: ReadySound[] = from === null ? ['intro'] : [];
  if (to === 'countdown') play.push('countdown');
  if (to === 'accepted') play.push('acceptedLoop');
  const fade = (['countdown', 'acceptedLoop'] as const).filter((x) => !play.includes(x));
  return { play, fade };
}

const SOUND_FILE: Record<ReadySound, string> = {
  intro: 'ready-intro', countdown: 'ready-countdown', acceptedLoop: 'ready-accepted-loop',
};
const FADE_MS = 300;

type Clip = 'countdown' | 'acceptedIntro' | 'acceptedIdle' | 'declined';
const CLIP_FILE: Record<Clip, string> = {
  countdown: 'ready-countdown', acceptedIntro: 'ready-accepted-intro', acceptedIdle: 'ready-accepted-idle', declined: 'ready-declined',
};

interface Card {
  id: string;
  root: HTMLElement;
  scene: HTMLElement;
  title: HTMLElement;
  details: HTMLElement;
  pips: HTMLElement;
  accept: HTMLButtonElement;
  decline: HTMLButtonElement;
  clips: Record<Clip, HTMLVideoElement>;
  sounds: Record<ReadySound, HTMLAudioElement>;
  /** The ping sound volume, 0 to 1. */
  volume: number;
  phase: ReadyPhase | null;
  endsAt: number;
  /** Keeps the countdown's speed matched to the time left. */
  pace: number | undefined;
}

/** The card stays up while its vote does: redrawing it would restart the videos. */
let card: Card | null = null;

function clip(name: Clip, loop: boolean): HTMLVideoElement {
  const v = el('video', `clip ${name}`);
  v.src = `../ui/${CLIP_FILE[name]}.webm`;
  v.muted = true;
  v.loop = loop;
  v.preload = 'auto';
  v.hidden = true;
  return v;
}

function sound(name: ReadySound, loop: boolean): HTMLAudioElement {
  const a = new Audio(`../ui/${SOUND_FILE[name]}.ogg`);
  a.loop = loop;
  a.preload = 'auto';
  return a;
}

/** Fades on a timer, not animation frames: those stop in a hidden window, and the accepted loop would never end. */
function fadeOut(a: HTMLAudioElement): void {
  if (a.paused) return;
  const from = a.volume;
  const start = performance.now();
  const timer = setInterval(() => {
    const left = 1 - (performance.now() - start) / FADE_MS;
    if (left > 0 && !a.paused) {
      a.volume = from * left;
      return;
    }
    clearInterval(timer);
    a.pause();
    a.volume = from;
  }, 30);
}

function sounds(c: Card, from: ReadyPhase | null, to: ReadyPhase): void {
  const { play, fade } = readySounds(from, to);
  for (const name of fade) fadeOut(c.sounds[name]);
  if (c.volume <= 0) return;
  for (const name of play) {
    const a = c.sounds[name];
    a.volume = c.volume;
    a.currentTime = 0;
    void a.play().catch(() => undefined); // no sound is better than a broken card
  }
}

function play(c: Card, name: Clip): void {
  for (const [key, v] of Object.entries(c.clips) as [Clip, HTMLVideoElement][]) {
    if (key === name) continue;
    v.hidden = true;
    v.pause();
  }
  const v = c.clips[name];
  v.hidden = false;
  v.currentTime = 0;
  void v.play().catch(() => undefined); // a video that can't play leaves the frame as it is
}

function pace(c: Card): void {
  const v = c.clips.countdown;
  v.playbackRate = countdownRate(v.duration, v.currentTime, (c.endsAt - Date.now()) / 1000);
}

function enter(c: Card, phase: ReadyPhase): void {
  sounds(c, c.phase, phase);
  clearInterval(c.pace);
  c.pace = undefined;
  c.scene.classList.toggle('declined', phase === 'declined');
  if (phase === 'countdown') {
    play(c, 'countdown');
    pace(c);
    c.pace = window.setInterval(() => pace(c), 1000);
  } else if (phase === 'accepted') {
    play(c, 'acceptedIntro');
  } else if (phase === 'declined') {
    play(c, 'declined');
  } else {
    c.clips.countdown.pause(); // the vote ended without us: the ring stops where it was
  }
  c.phase = phase;
}

function build(id: string, endsAt: number, volume: number, act: (a: PanelAction) => void): Card {
  const root = el('section', 'vote ready');
  const body = el('div', 'body');
  const scene = el('div', 'scene');
  const timer = el('div', 'timer');
  const clips: Record<Clip, HTMLVideoElement> = {
    countdown: clip('countdown', false),
    acceptedIntro: clip('acceptedIntro', false),
    acceptedIdle: clip('acceptedIdle', true),
    declined: clip('declined', false),
  };
  timer.append(...Object.values(clips));
  const status = el('div', 'status');
  const title = el('h1', 'title');
  const details = el('p', 'details');
  const pips = el('div', 'pips');
  status.append(title, details, pips);
  const buttons = el('div', 'buttons');
  const button = (className: string, yes: boolean): HTMLButtonElement => {
    const b = el('button', className);
    b.type = 'button';
    b.addEventListener('click', () => act({ t: 'ballot', yes }));
    return b;
  };
  const accept = button('accept', true);
  const decline = button('decline', false);
  buttons.append(accept, decline);
  body.append(scene, el('div', 'frame'), timer, el('div', 'map'), status, buttons);
  root.append(body);
  const sounds: Record<ReadySound, HTMLAudioElement> = {
    intro: sound('intro', false), countdown: sound('countdown', false), acceptedLoop: sound('acceptedLoop', true),
  };
  const c: Card = { id, root, scene, title, details, pips, accept, decline, clips, sounds, volume, phase: null, endsAt, pace: undefined };
  clips.acceptedIntro.addEventListener('ended', () => {
    if (c.phase === 'accepted') play(c, 'acceptedIdle');
  });
  return c;
}

/** Takes the ready check down and stops its videos and sounds at once: its window is about to hide. */
export function dropReady(): void {
  if (!card) return;
  clearInterval(card.pace);
  for (const m of [...Object.values(card.clips), ...Object.values(card.sounds)]) m.pause();
  card = null;
}

/** Draws the client's ready check: the frame round the map, its timer videos and sounds, and Accept and Decline under it. */
export function renderReady(root: HTMLElement, state: PanelState, act: (a: PanelAction) => void): void {
  const v = state.vote;
  if (!v) return;
  const t = strings(state.lang);
  const members = state.room.members;
  const me = members.find((m) => m.self)?.peer;
  const mine = me === undefined ? undefined : v.ballots[me];

  if (!card || card.id !== v.id) {
    dropReady();
    card = build(v.id, v.endsAt, state.volume, act);
  }
  const c = card;
  c.volume = state.volume;
  if (!root.contains(c.root)) root.replaceChildren(c.root);

  const phase = readyPhase(mine, state.voteOver);
  // Cut off with an ellipsis when long: the whole topic shows on hover while it is the line shown.
  c.details.title = phase === 'accepted' || phase === 'declined' ? '' : (v.topic ?? '');
  if (phase === 'accepted') {
    c.title.textContent = t.readyAccepted;
    c.details.textContent = t.readyWaiting;
  } else if (phase === 'declined') {
    c.title.textContent = t.readyDeclined;
    c.details.textContent = '';
  } else {
    c.title.textContent = voteTitle(v, members, t);
    c.details.textContent = readyDetails(v, members, t);
  }
  c.pips.replaceChildren(...voteBoxes(v, members).map((b) => {
    const pip = el('span', b.answer);
    pip.title = b.name;
    return pip;
  }));

  const answerable = canAnswer(v, me, state.voteOver, Date.now());
  c.accept.textContent = t.voteAccept;
  c.decline.textContent = t.voteDecline;
  c.accept.disabled = !answerable;
  c.decline.disabled = !answerable;
  c.decline.classList.toggle('chosen', mine === false);
  if (c.phase !== phase) enter(c, phase);
}
