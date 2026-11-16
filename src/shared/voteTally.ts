import type { VoteKind } from './roomProtocol';

/** How long each vote stays open. Our own constants: a sender's clock or wish never sets them. */
export const VOTE_MS: Record<VoteKind, number> = { ff: 60_000, kick: 60_000, ready: 15_000 };

/** Yes ballots a vote needs: surrender 70% rounded up, ready check everyone, kick more than half. */
export function needed(kind: VoteKind, voters: number): number {
  if (kind === 'ff') return Math.ceil(0.7 * voters);
  if (kind === 'ready') return voters;
  return Math.floor(voters / 2) + 1;
}

export interface VoteView {
  id: string;
  kind: VoteKind;
  starter: string;
  target?: string;
  /** What a surrender or ready check is about, when its starter said. */
  topic?: string;
  /** Fixed at the start; the kick target is not among them. */
  voters: readonly string[];
  ballots: Readonly<Record<string, boolean>>;
  endsAt: number;
}

export interface VoteOutcome {
  id: string;
  kind: VoteKind;
  target?: string;
  passed: boolean;
  yes: number;
  voters: number;
  /** Voters who said no, or left. */
  declined: string[];
  /** Voters who never answered. */
  missing: string[];
}

interface OpenVote {
  id: string;
  kind: VoteKind;
  starter: string;
  target?: string;
  topic?: string;
  voters: string[];
  ballots: Record<string, boolean>;
  endsAt: number;
}

/** One vote at a time: who may vote, who answered, and whether it has passed, failed or run out. */
export class VoteTally {
  private open: OpenVote | null = null;

  constructor(private readonly now: () => number) {}

  /** False while another vote is open. The starter's yes counts from the start. */
  start(v: { id: string; kind: VoteKind; starter: string; target?: string; topic?: string; voters: string[] }): boolean {
    if (this.open) return false;
    const voters = [...new Set(v.voters)].filter((p) => p !== v.target);
    const ballots: Record<string, boolean> = voters.includes(v.starter) ? { [v.starter]: true } : {};
    this.open = {
      id: v.id, kind: v.kind, starter: v.starter, ...(v.target === undefined ? {} : { target: v.target }),
      ...(v.topic === undefined ? {} : { topic: v.topic }), voters, ballots, endsAt: this.now() + VOTE_MS[v.kind],
    };
    return true;
  }

  /** True when the ballot was taken: the first one per voter is final. */
  ballot(voter: string, id: string, yes: boolean): boolean {
    const o = this.open;
    if (!o || o.id !== id || !o.voters.includes(voter) || voter in o.ballots) return false;
    o.ballots[voter] = yes;
    return true;
  }

  /** A voter who is gone counts as no, unless they already answered. */
  left(voter: string): void {
    const o = this.open;
    if (o && o.voters.includes(voter) && !(voter in o.ballots)) o.ballots[voter] = false;
  }

  view(): VoteView | null {
    const o = this.open;
    return o && { ...o, voters: [...o.voters], ballots: { ...o.ballots } };
  }

  /** The result, once: as soon as it can't change, or at the end with the unanswered counted as no. */
  check(): VoteOutcome | null {
    const o = this.open;
    if (!o) return null;
    const answered = o.voters.filter((p) => p in o.ballots);
    const yes = answered.filter((p) => o.ballots[p]).length;
    const missing = o.voters.filter((p) => !(p in o.ballots));
    const need = needed(o.kind, o.voters.length);
    const passed = yes >= need;
    if (!passed && yes + missing.length >= need && this.now() < o.endsAt) return null;
    this.open = null;
    return {
      id: o.id, kind: o.kind, ...(o.target === undefined ? {} : { target: o.target }), passed, yes, voters: o.voters.length,
      declined: answered.filter((p) => !o.ballots[p]), missing,
    };
  }
}
