import { describe, expect, it } from 'vitest';
import { countdownRate, readyDetails, readyPhase, readySounds } from '../../src/renderer/panel/readyCheck';
import { strings } from '../../src/shared/i18n';
import type { RoomMember } from '../../src/shared/room';
import type { VoteView } from '../../src/shared/voteTally';

describe('readyDetails', () => {
  const alex: RoomMember = {
    peer: 'bb', name: 'Alex', color: 0, rgb: null, path: 'lan', status: 'on', needsUpdate: false, noEmotes: false,
    noChat: false, textOff: false, votesOff: false, muted: false, self: false,
  };
  const view = (over: Partial<VoteView> = {}): VoteView => ({
    id: '01234567', kind: 'ready', starter: 'bb', voters: ['bb'], ballots: {}, endsAt: 0, ...over,
  });

  it('names who started it, with what for when they said', () => {
    expect(readyDetails(view(), [alex], strings('en'))).toBe('Started by Alex');
    expect(readyDetails(view({ topic: 'ranked?' }), [alex], strings('en'))).toBe('Alex: ranked?');
    expect(readyDetails(view({ topic: '排位' }), [alex], strings('zh-CN'))).toBe('Alex：排位');
  });

  it('still shows the topic once its starter has left', () => {
    expect(readyDetails(view({ topic: 'ranked?' }), [], strings('en'))).toBe('ranked?');
    expect(readyDetails(view(), [], strings('en'))).toBe('');
  });
});

describe('readyPhase', () => {
  it('counts down until we answer, then shows our answer even after the vote ends', () => {
    expect(readyPhase(undefined, false)).toBe('countdown');
    expect(readyPhase(true, false)).toBe('accepted');
    expect(readyPhase(false, true)).toBe('declined');
  });

  it('stops the countdown when the vote ends before we answer', () => {
    expect(readyPhase(undefined, true)).toBe('ended');
  });
});

describe('countdownRate', () => {
  it('slows the 10.7 s video so it ends with a 15 s vote', () => {
    expect(countdownRate(10.733, 0, 15)).toBeCloseTo(0.7155, 3);
  });

  it('catches up when the video is behind the time left', () => {
    expect(countdownRate(10.733, 2.733, 4)).toBe(2);
  });

  it('plays at normal speed with no time left or no video loaded yet', () => {
    expect(countdownRate(10.733, 5, 0)).toBe(1);
    expect(countdownRate(10.733, 5, -1)).toBe(1);
    expect(countdownRate(Number.NaN, 0, 10)).toBe(1);
  });
});

describe('readySounds', () => {
  it('plays match found and the countdown when the card appears', () => {
    expect(readySounds(null, 'countdown')).toEqual({ play: ['intro', 'countdown'], fade: ['acceptedLoop'] });
  });

  it('plays match found and the accepted loop for a card that appears already accepted', () => {
    expect(readySounds(null, 'accepted')).toEqual({ play: ['intro', 'acceptedLoop'], fade: ['countdown'] });
  });

  it('swaps the countdown for the accepted loop when we accept', () => {
    expect(readySounds('countdown', 'accepted')).toEqual({ play: ['acceptedLoop'], fade: ['countdown'] });
  });

  it('goes quiet when we decline or the vote ends without us', () => {
    expect(readySounds('countdown', 'declined')).toEqual({ play: [], fade: ['countdown', 'acceptedLoop'] });
    expect(readySounds('countdown', 'ended')).toEqual({ play: [], fade: ['countdown', 'acceptedLoop'] });
  });
});
