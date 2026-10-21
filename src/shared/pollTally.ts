import { sanitizeText } from './roomProtocol';

export type PollMode = 'single' | 'multiple' | 'yesno';
export interface PollDefinition {
  mode: PollMode;
  question: string;
  options: string[];
}
export interface PollView extends PollDefinition {
  id: string;
  starter: string;
  voters: string[];
  ballots: Record<string, number[]>;
  counts: number[];
  endsAt: number;
  over: boolean;
}

export const POLL_MS = 60_000;

export function normalizePoll(raw: unknown): PollDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { mode, question, options } = raw as Record<string, unknown>;
  if (mode !== 'single' && mode !== 'multiple' && mode !== 'yesno') return null;
  if (typeof question !== 'string' || [...question].length > 60) return null;
  const safe = sanitizeText(question);
  if (!safe) return null;
  if (mode === 'yesno') return { mode, question: safe, options: [] };
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) return null;
  const clean: string[] = [];
  for (const option of options) {
    if (typeof option !== 'string' || [...option].length > 24) return null;
    const text = sanitizeText(option);
    if (!text || clean.includes(text)) return null;
    clean.push(text);
  }
  return { mode, question: safe, options: clean };
}

export class PollTally {
  private open: PollView | null = null;

  constructor(private readonly now: () => number) {}

  start(id: string, starter: string, definition: PollDefinition, voters: string[]): boolean {
    const poll = normalizePoll(definition);
    if (this.open && !this.open.over || !poll) return false;
    this.open = {
      ...poll, id, starter, voters: [...new Set(voters)], ballots: {},
      counts: Array<number>(poll.mode === 'yesno' ? 2 : poll.options.length).fill(0),
      endsAt: this.now() + POLL_MS, over: false,
    };
    return true;
  }

  answer(peer: string, id: string, choices: readonly number[]): boolean {
    const poll = this.open;
    if (!poll || poll.over || this.now() >= poll.endsAt || poll.id !== id ||
        !poll.voters.includes(peer) || Object.hasOwn(poll.ballots, peer)) return false;
    if (!choices.length || choices.length > poll.counts.length || new Set(choices).size !== choices.length ||
        poll.mode !== 'multiple' && choices.length !== 1 ||
        !choices.every((choice) => Number.isInteger(choice) && choice >= 0 && choice < poll.counts.length)) return false;
    poll.ballots[peer] = [...choices];
    for (const choice of choices) poll.counts[choice] += 1;
    return true;
  }

  view(): PollView | null {
    const poll = this.open;
    if (!poll) return null;
    if (this.now() >= poll.endsAt || poll.voters.every((peer) => Object.hasOwn(poll.ballots, peer))) poll.over = true;
    return {
      ...poll, options: [...poll.options], voters: [...poll.voters], counts: [...poll.counts],
      ballots: Object.fromEntries(Object.entries(poll.ballots).map(([peer, choices]) => [peer, [...choices]])),
    };
  }

  clear(): void {
    this.open = null;
  }
}