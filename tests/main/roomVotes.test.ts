import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomVotes, voteResultLine, type RoomVotesDeps } from '../../src/main/roomVotes';
import { strings } from '../../src/shared/i18n';
import type { RoomMember, RoomStateCore } from '../../src/shared/room';
import type { BallotMsg, VoteMsg } from '../../src/shared/roomProtocol';
import type { VoteOutcome, VoteView } from '../../src/shared/voteTally';

const member = (peer: string, over: Partial<RoomMember> = {}): RoomMember => ({
  peer, name: peer.toUpperCase(), color: 2, rgb: null, path: 'lan', status: 'on', needsUpdate: false, noEmotes: false,
  noChat: false, textOff: false, votesOff: false, muted: false, self: false, ...over,
});

/** A room that only has members, a phase and the vote traffic, which is all the votes unit looks at. */
class FakeRoom extends EventEmitter {
  self = 'me';
  phase: RoomStateCore['phase'] = 'active';
  members: RoomMember[] = [member('me', { self: true }), member('a'), member('b'), member('c')];
  votes: { id: string; kind: string; target?: string }[] = [];
  ballots: { id: string; yes: boolean }[] = [];
  kicked: string[] = [];
  state(): Pick<RoomStateCore, 'phase' | 'members'> {
    return { phase: this.phase, members: this.members };
  }
  sendVote(v: { id: string; kind: string; target?: string }): void {
    this.votes.push(v);
  }
  sendBallot(id: string, yes: boolean): void {
    this.ballots.push({ id, yes });
  }
  kick(peer: string): void {
    this.kicked.push(peer);
  }
  /** What the manager does when the member list changes. */
  setMembers(members: RoomMember[]): void {
    this.members = members;
    this.emit('state', this.state());
  }
}

const voteFrom = (peer: string, over: Partial<VoteMsg> = {}): VoteMsg => ({
  t: 'vote', peer, seq: 1, ts: 0, id: 'abcdef01', kind: 'ff', ...over,
} as VoteMsg);
/** The ID of the first vote we start. */
const OWN = '00000001';
const ballotFrom = (peer: string, yes: boolean, id = 'abcdef01'): BallotMsg => ({
  t: 'ballot', peer, seq: 1, ts: 0, id, yes,
} as BallotMsg);

function setup() {
  const room = new FakeRoom();
  const views: (VoteView | null)[] = [];
  const overs: boolean[] = [];
  const results: VoteOutcome[] = [];
  let kickedYou = 0;
  let n = 0;
  const deps: RoomVotesDeps = {
    room: room as unknown as RoomVotesDeps['room'],
    now: () => Date.now(),
    randomId: () => String(++n).padStart(8, '0'),
    onView: (v, over) => {
      views.push(v);
      overs.push(over ?? false);
    },
    onResult: (o) => results.push(o),
    onKicked: () => { kickedYou++; },
  };
  const votes = new RoomVotes(deps);
  return { room, votes, views, overs, results, kickedYou: () => kickedYou };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RoomVotes', () => {
  it('starts a vote, sends it, and repeats our ballot every 3 s until it closes', () => {
    const { room, votes, views, results } = setup();
    expect(votes.start('ff')).toBe('started');
    expect(room.votes).toEqual([{ id: OWN, kind: 'ff' }]);
    expect(views.at(-1)).toMatchObject({ id: OWN, starter: 'me', voters: ['me', 'a', 'b', 'c'] });
    expect(room.ballots).toEqual([]);
    vi.advanceTimersByTime(3000);
    expect(room.ballots).toEqual([{ id: OWN, yes: true }]);
    vi.advanceTimersByTime(6000);
    expect(room.ballots).toHaveLength(3);

    // Two no's end it at once, and the repeating stops.
    room.emit('ballot', ballotFrom('a', false, OWN));
    expect(results).toHaveLength(0);
    room.emit('ballot', ballotFrom('b', false, OWN));
    expect(results).toEqual([
      expect.objectContaining({ passed: false, yes: 1, voters: 4, declined: ['a', 'b'], missing: ['c'] }),
    ]);
    const sent = room.ballots.length;
    vi.advanceTimersByTime(10_000);
    expect(room.ballots).toHaveLength(sent);
  });

  it('sends what our surrender or ready check is about, and shows it', () => {
    const { room, votes, views } = setup();
    expect(votes.start('ready', undefined, 'ranked?')).toBe('started');
    expect(room.votes).toEqual([{ id: OWN, kind: 'ready', q: 'ranked?' }]);
    expect(views.at(-1)).toMatchObject({ kind: 'ready', topic: 'ranked?' });
  });

  it("shows the topic of a member's vote, and none for a vote without one", () => {
    const { room, views } = setup();
    room.emit('vote', voteFrom('a', { q: '打不过了' }));
    expect(views.at(-1)).toMatchObject({ starter: 'a', topic: '打不过了' });
    const { room: other, views: plain } = setup();
    other.emit('vote', voteFrom('a'));
    expect(plain.at(-1)).not.toHaveProperty('topic');
  });

  it('never puts a topic on a kick', () => {
    const { room, votes, views } = setup();
    expect(votes.start('kick', 'a', 'bye')).toBe('started');
    expect(room.votes).toEqual([{ id: OWN, kind: 'kick', target: 'a' }]);
    expect(views.at(-1)).not.toHaveProperty('topic');
  });

  it('opens a vote a member sends, and our answer is sent once and kept', () => {
    const { room, votes, views } = setup();
    room.emit('vote', voteFrom('a'));
    expect(views.at(-1)).toMatchObject({ starter: 'a', ballots: { a: true } });
    votes.answer(true);
    expect(room.ballots).toEqual([{ id: 'abcdef01', yes: true }]);
    votes.answer(false);
    expect(room.ballots).toHaveLength(1);
    expect(room.votes).toEqual([]);
  });

  it('opens nothing for a vote from a muted member', () => {
    const { room, votes, views } = setup();
    room.members = [member('me', { self: true }), member('a', { muted: true }), member('b')];
    room.emit('vote', voteFrom('a'));
    vi.advanceTimersByTime(10_000);
    votes.answer(true);
    expect(views).toEqual([]);
    expect(room.ballots).toEqual([]);
    // From someone we don't know, or a kick of someone we don't know, neither.
    room.emit('vote', voteFrom('stranger'));
    room.emit('vote', voteFrom('b', { kind: 'kick', target: 'ffffffffffffffff' }));
    expect(views).toEqual([]);
  });

  it('leaves members who cannot answer out of the voters', () => {
    const { room, votes, views } = setup();
    room.members = [
      member('me', { self: true }), member('a', { noChat: true }), member('b', { votesOff: true }), member('c'),
    ];
    votes.start('ready');
    expect(views.at(-1)?.voters).toEqual(['me', 'c']);
  });

  it('answers busy while a vote runs', () => {
    const { room, votes, views } = setup();
    expect(votes.start('ff')).toBe('started');
    expect(votes.start('ready')).toBe('busy');
    room.emit('vote', voteFrom('a', { id: '11111111', kind: 'ready' }));
    expect(room.votes).toHaveLength(1);
    expect(views.filter((v) => v?.id === '11111111')).toEqual([]);
  });

  it('refuses to kick ourselves or someone we do not know', () => {
    const { room, votes } = setup();
    expect(votes.start('kick', 'me')).toBe('self');
    expect(votes.start('kick', 'nobody')).toBe('unknown');
    expect(room.votes).toEqual([]);
    expect(votes.start('kick', 'a')).toBe('started');
    expect(room.votes).toEqual([{ id: OWN, kind: 'kick', target: 'a' }]);
  });

  it('drops the kicked member when a kick passes', () => {
    const { room, votes, results, kickedYou } = setup();
    votes.start('kick', 'a');
    room.emit('ballot', ballotFrom('b', true, OWN));
    expect(results).toEqual([expect.objectContaining({ passed: true, target: 'a', yes: 2, voters: 3 })]);
    expect(room.kicked).toEqual(['a']);
    vi.advanceTimersByTime(60_000);
    expect(room.kicked).toEqual(['a']);
    expect(kickedYou()).toBe(0);
  });

  it('keeps everyone when a kick fails', () => {
    const { room, votes, results } = setup();
    votes.start('kick', 'a');
    room.emit('ballot', ballotFrom('b', false, OWN));
    room.emit('ballot', ballotFrom('c', false, OWN));
    expect(results).toEqual([expect.objectContaining({ passed: false })]);
    expect(room.kicked).toEqual([]);
  });

  it('leaves the room when we are the one kicked', () => {
    const { room, results, kickedYou } = setup();
    room.emit('vote', voteFrom('a', { kind: 'kick', target: 'me' }));
    room.emit('ballot', ballotFrom('b', true));
    expect(results).toEqual([expect.objectContaining({ passed: true, target: 'me', voters: 3 })]);
    expect(kickedYou()).toBe(1);
    expect(room.kicked).toEqual([]);
  });

  it('counts a member who drops mid-vote as no', () => {
    const { room, votes, results } = setup();
    votes.start('ready');
    room.setMembers(room.members.filter((m) => m.peer !== 'b'));
    expect(results).toEqual([
      expect.objectContaining({ passed: false, declined: ['b'], missing: ['a', 'c'] }),
    ]);
  });

  it('times out at our own limit and closes the widget 3 s after the result', () => {
    const { votes, views, results } = setup();
    votes.start('ready');
    vi.advanceTimersByTime(14_000);
    expect(results).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(results).toEqual([expect.objectContaining({ passed: false, missing: ['a', 'b', 'c'] })]);
    expect(views.at(-1)).not.toBeNull();
    vi.advanceTimersByTime(2999);
    expect(views.at(-1)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(views.at(-1)).toBeNull();
  });

  it('sends the vote once more, marked over, when its result is in', () => {
    const { votes, views, overs } = setup();
    votes.start('ready');
    expect(overs.every((o) => !o)).toBe(true);
    vi.advanceTimersByTime(15_000);
    expect(overs.at(-1)).toBe(true);
    expect(views.at(-1)).toMatchObject({ kind: 'ready', ballots: { me: true } });
    vi.advanceTimersByTime(3000);
    expect(views.at(-1)).toBeNull();
  });

  it('reports the open vote only until its result is in', () => {
    const { votes } = setup();
    expect(votes.current()).toBeNull();
    votes.start('ready');
    expect(votes.current()).toMatchObject({ kind: 'ready' });
    vi.advanceTimersByTime(15_000);
    expect(votes.current()).toBeNull();
  });

  it('keeps a new vote on screen when it starts before the last widget closed', () => {
    const { votes, views } = setup();
    votes.start('ready');
    vi.advanceTimersByTime(15_000);
    expect(votes.start('ff')).toBe('started');
    vi.advanceTimersByTime(3000);
    expect(views.at(-1)).toMatchObject({ kind: 'ff' });
  });

  it('closes the vote when the room is left', () => {
    const { room, votes, views, results } = setup();
    votes.start('ff');
    room.phase = 'idle';
    room.setMembers([]);
    expect(views.at(-1)).toBeNull();
    const sent = room.ballots.length;
    vi.advanceTimersByTime(120_000);
    expect(room.ballots).toHaveLength(sent);
    expect(results).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops listening and clears its timers when stopped', () => {
    const { room, votes, views, results } = setup();
    votes.start('ff');
    votes.stop();
    expect(views.at(-1)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    room.emit('vote', voteFrom('a'));
    room.emit('ballot', ballotFrom('a', false));
    vi.advanceTimersByTime(120_000);
    expect(results).toEqual([]);
    expect(room.listenerCount('vote')).toBe(0);
  });
});

describe('voteResultLine', () => {
  const nameOf = (peer: string): string => ({ a: 'Alex', b: 'Bo', c: 'Cy' })[peer] ?? '?';
  const outcome = (over: Partial<VoteOutcome>): VoteOutcome => ({
    id: 'x', kind: 'ff', passed: false, yes: 2, voters: 5, declined: [], missing: [], ...over,
  });

  it('writes a surrender result with the count', () => {
    expect(voteResultLine(outcome({}), nameOf, strings('en'))).toBe('Surrender vote failed (2 / 5)');
    expect(voteResultLine(outcome({ passed: true, yes: 4 }), nameOf, strings('zh-CN'))).toBe('投降投票通过（4 / 5）');
  });

  it('says everyone is ready, or who is not', () => {
    const ready = outcome({ kind: 'ready', passed: true, yes: 3, voters: 3 });
    expect(voteResultLine(ready, nameOf, strings('en'))).toBe('Everyone is ready');
    const notReady = outcome({ kind: 'ready', declined: ['a'], missing: ['c'] });
    expect(voteResultLine(notReady, nameOf, strings('en'))).toBe('Not ready: Alex, Cy');
    expect(voteResultLine(notReady, nameOf, strings('zh-CN'))).toBe('未就位：Alex、Cy');
  });

  it('names the member a kick vote was about', () => {
    const kick = outcome({ kind: 'kick', target: 'b', passed: true, yes: 3, voters: 4 });
    expect(voteResultLine(kick, nameOf, strings('en'))).toBe('Vote to remove Bo passed (3 / 4)');
  });
});
