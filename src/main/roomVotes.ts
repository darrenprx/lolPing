import type { Strings } from '../shared/i18n';
import type { RoomMember } from '../shared/room';
import type { BallotMsg, VoteKind, VoteMsg } from '../shared/roomProtocol';
import { VoteTally, type VoteOutcome, type VoteView } from '../shared/voteTally';
import type { RoomManager } from './roomManager';

export interface RoomVotesDeps {
  room: Pick<RoomManager, 'self' | 'state' | 'sendVote' | 'sendBallot' | 'kick' | 'on' | 'off'>;
  now(): number;
  /** A fresh vote ID (8 hex characters). */
  randomId(): string;
  /** The open vote as it stands, or null once its widget should go. `over`: this is its last state, the result is in. */
  onView(v: VoteView | null, over?: boolean): void;
  /** The result, once; for a kick it comes before the member is removed, so their name can still be looked up. */
  onResult(o: VoteOutcome): void;
  /** A kick against us passed: the caller leaves the room. */
  onKicked(): void;
}

const CHECK_MS = 1000;
const BALLOT_REPEAT_MS = 3000;
/** How long the widget stays after the result. */
const RESULT_SHOW_MS = 3000;

/** Runs surrender, ready check and kick votes over the room. */
export class RoomVotes {
  private tally: VoteTally;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private ballotTimer: ReturnType<typeof setInterval> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The widget has been told about a vote and not yet told to go. */
  private shown = false;

  constructor(private readonly d: RoomVotesDeps) {
    this.tally = new VoteTally(d.now);
    d.room.on('vote', this.onVote);
    d.room.on('ballot', this.onBallot);
    d.room.on('state', this.onState);
  }

  /** `topic` is what a surrender or ready check is about; a kick never has one. */
  start(kind: VoteKind, target?: string, topic?: string): 'started' | 'busy' | 'self' | 'unknown' {
    if (this.tally.view()) return 'busy';
    const { room } = this.d;
    const s = room.state();
    if (s.phase !== 'active') return 'unknown';
    if (kind === 'kick') {
      if (target === room.self) return 'self';
      if (!target || !s.members.some((m) => m.peer === target)) return 'unknown';
    }
    const id = this.d.randomId();
    const about = kind !== 'kick' && topic ? { topic } : {};
    this.begin({ id, kind, starter: room.self, ...(kind === 'kick' ? { target } : about), voters: this.votersOf(s.members) });
    room.sendVote(kind === 'kick' && target ? { id, kind, target } : { id, kind, ...(about.topic ? { q: about.topic } : {}) });
    this.settle();
    return 'started';
  }

  /** The vote that is still counting; null once its result is in, though its widget stays a moment longer. */
  current(): VoteView | null {
    return this.tally.view();
  }

  /** Our answer to the open vote. The first one is final and is repeated until the vote closes. */
  answer(yes: boolean): void {
    const v = this.tally.view();
    if (!v || !this.tally.ballot(this.d.room.self, v.id, yes)) return;
    this.d.room.sendBallot(v.id, yes);
    this.push();
    this.settle();
  }

  stop(): void {
    const { room } = this.d;
    room.off('vote', this.onVote);
    room.off('ballot', this.onBallot);
    room.off('state', this.onState);
    this.closeNow();
  }

  /** Members who can answer: not those on an older app, with votes off, or that we can't read; and ourselves. */
  private votersOf(members: readonly RoomMember[]): string[] {
    return members.filter((m) => m.self || !(m.noChat || m.votesOff || m.needsUpdate)).map((m) => m.peer);
  }

  private begin(v: { id: string; kind: VoteKind; starter: string; target?: string; topic?: string; voters: string[] }): void {
    this.clearTimers();
    this.tally.start(v);
    this.checkTimer = setInterval(() => this.settle(), CHECK_MS);
    this.ballotTimer = setInterval(() => this.repeatBallot(), BALLOT_REPEAT_MS);
    this.push();
  }

  private push(): void {
    const v = this.tally.view();
    if (!v) return;
    this.shown = true;
    this.d.onView(v);
  }

  private repeatBallot(): void {
    const v = this.tally.view();
    const mine = v?.ballots[this.d.room.self];
    if (v && mine !== undefined) this.d.room.sendBallot(v.id, mine);
  }

  private settle(): void {
    const last = this.tally.view();
    const o = this.tally.check();
    if (!o) return;
    this.clearTimers();
    // Set before the callbacks: leaving the room in onKicked closes the widget at once.
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.hide();
    }, RESULT_SHOW_MS);
    // Before onResult: leaving the room in onKicked closes the widget, and this must not bring it back.
    if (last) {
      this.shown = true;
      this.d.onView(last, true);
    }
    this.d.onResult(o);
    if (o.passed && o.kind === 'kick' && o.target) {
      if (o.target === this.d.room.self) this.d.onKicked();
      else this.d.room.kick(o.target);
    }
  }

  private hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.d.onView(null);
  }

  /** Drops the vote without a result: the room was left, or we were stopped. */
  private closeNow(): void {
    this.clearTimers();
    this.tally = new VoteTally(this.d.now);
    this.hide();
  }

  private clearTimers(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.ballotTimer) clearInterval(this.ballotTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.checkTimer = this.ballotTimer = this.closeTimer = null;
  }

  private readonly onVote = (msg: VoteMsg): void => {
    if (this.tally.view()) return;
    const { room } = this.d;
    const s = room.state();
    const sender = s.members.find((m) => m.peer === msg.peer);
    // A muted member's vote opens nothing for us, so we count as no in it.
    if (s.phase !== 'active' || !sender || sender.self || sender.muted) return;
    if (msg.kind === 'kick') {
      const known = msg.target === room.self || s.members.some((m) => m.peer === msg.target);
      if (!msg.target || msg.target === msg.peer || !known) return;
    }
    this.begin({
      id: msg.id, kind: msg.kind, starter: msg.peer, ...(msg.target === undefined ? {} : { target: msg.target }),
      ...(msg.q === undefined ? {} : { topic: msg.q }), voters: this.votersOf(s.members),
    });
    this.settle();
  };

  private readonly onBallot = (msg: BallotMsg): void => {
    if (!this.tally.ballot(msg.peer, msg.id, msg.yes)) return;
    this.push();
    this.settle();
  };

  private readonly onState = (): void => {
    const s = this.d.room.state();
    if (s.phase === 'idle') return this.closeNow();
    const v = this.tally.view();
    if (!v) return;
    const here = new Set(s.members.map((m) => m.peer));
    for (const p of v.voters) if (!here.has(p) && p !== this.d.room.self) this.tally.left(p);
    // Presence updates also land here: tell the widget only when someone's answer changed.
    if (Object.keys(this.tally.view()?.ballots ?? {}).length !== Object.keys(v.ballots).length) this.push();
    this.settle();
  };
}

/** The line a result becomes, on screen and in the History. `nameOf` also knows members who have since left. */
export function voteResultLine(o: VoteOutcome, nameOf: (peer: string) => string, t: Strings): string {
  if (o.kind === 'ff') return t.voteResultFf(o.passed, o.yes, o.voters);
  if (o.kind === 'ready') return o.passed ? t.readyAll : t.readyMissing([...o.declined, ...o.missing].map(nameOf));
  return t.voteResultKick(o.passed, nameOf(o.target ?? ''), o.yes, o.voters);
}
