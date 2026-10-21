import { describe, expect, it } from 'vitest';
import { normalizePoll, POLL_MS, PollTally } from '../../src/shared/pollTally';

describe('PollTally', () => {
  it('counts single selections without automatically voting for the starter', () => {
    const tally = new PollTally(() => 0);
    tally.start('poll', 'host', { mode: 'single', question: 'Map?', options: ['A', 'B'] }, ['host', 'guest']);
    expect(tally.view()?.ballots).toEqual({});
    expect(tally.answer('host', 'poll', [0, 1])).toBe(false);
    expect(tally.answer('host', 'poll', [1])).toBe(true);
    expect(tally.answer('host', 'poll', [0])).toBe(false);
    expect(tally.answer('stranger', 'poll', [0])).toBe(false);
    expect(tally.answer('guest', 'other', [0])).toBe(false);
    expect(tally.answer('guest', 'poll', [0])).toBe(true);
    expect(tally.view()).toMatchObject({ counts: [1, 1], over: true });
  });

  it('counts each selected option once in multiple choice polls', () => {
    const tally = new PollTally(() => 0);
    tally.start('poll', 'host', { mode: 'multiple', question: 'Roles?', options: ['A', 'B', 'C'] }, ['host']);
    for (const choices of [[], [0, 0], [-1], [3], [0.5]]) expect(tally.answer('host', 'poll', choices)).toBe(false);
    expect(tally.answer('host', 'poll', [0, 2])).toBe(true);
    expect(tally.view()?.counts).toEqual([1, 0, 1]);
  });

  it('ends yes or no polls at the deadline without treating missing answers as no', () => {
    let now = 0;
    const tally = new PollTally(() => now);
    tally.start('poll', 'host', { mode: 'yesno', question: 'Play?', options: [] }, ['host', 'guest']);
    expect(tally.answer('host', 'poll', [0])).toBe(true);
    now = POLL_MS;
    expect(tally.answer('guest', 'poll', [1])).toBe(false);
    expect(tally.view()).toMatchObject({ counts: [1, 0], over: true });
  });

  it('rejects malformed definitions and keeps a running poll', () => {
    expect(normalizePoll({ mode: 'single', question: 'Q', options: ['A', ' A '] })).toBeNull();
    expect(normalizePoll({ mode: 'single', question: ' ', options: ['A', 'B'] })).toBeNull();
    expect(normalizePoll({ mode: 'single', question: 'Q', options: ['A'] })).toBeNull();
    const tally = new PollTally(() => 0);
    const definition = { mode: 'yesno' as const, question: 'Q', options: [] };
    expect(tally.start('first', 'host', definition, ['host'])).toBe(true);
    expect(tally.start('second', 'host', definition, ['host'])).toBe(false);
    tally.clear();
    expect(tally.view()).toBeNull();
  });
});