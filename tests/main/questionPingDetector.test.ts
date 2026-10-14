import { describe, expect, it } from 'vitest';
import { QuestionPingDetector, type QuestionPingDetectorOptions } from '../../src/main/questionPingDetector';
import type { PingId } from '../../src/shared/pings';

function detector(overrides: Partial<QuestionPingDetectorOptions> = {}) {
  let now = 0;
  const fired: number[] = [];
  const o: QuestionPingDetectorOptions = {
    enabled: () => true,
    ping: () => 'danger',
    threshold: () => 3,
    windowMs: () => 5000,
    cooldownMs: 10_000,
    now: () => now,
    onTrigger: () => fired.push(now),
    ...overrides,
  };
  return { d: new QuestionPingDetector(o), advance: (ms: number) => (now += ms), fired };
}

describe('QuestionPingDetector', () => {
  it('fires when the threshold is reached inside the window', () => {
    const { d, fired } = detector();
    d.record('danger');
    d.record('danger');
    expect(fired).toEqual([]);
    d.record('danger');
    expect(fired).toEqual([0]);
  });

  it('ignores pings of other kinds without resetting the window', () => {
    const { d, fired } = detector();
    d.record('danger');
    d.record('push');
    d.record('danger');
    d.record('danger');
    expect(fired).toEqual([0]);
  });

  it('forgets pings that fell out of the window', () => {
    const { d, advance, fired } = detector();
    d.record('danger');
    d.record('danger');
    advance(5001);
    d.record('danger');
    expect(fired).toEqual([]);
  });

  it('stays quiet through the cooldown after a trigger', () => {
    const { d, advance, fired } = detector();
    for (let i = 0; i < 6; i++) d.record('danger');
    expect(fired).toEqual([0]);
    advance(9999);
    d.record('danger');
    d.record('danger');
    d.record('danger');
    expect(fired).toEqual([0]);
    advance(1);
    d.record('danger');
    d.record('danger');
    d.record('danger');
    expect(fired).toEqual([0, 10_000]);
  });

  it('records nothing while the feature is off, and starts fresh when turned on', () => {
    let on = false;
    const { d, fired } = detector({ enabled: () => on });
    for (let i = 0; i < 5; i++) d.record('danger');
    expect(fired).toEqual([]);
    on = true;
    d.record('danger');
    expect(fired).toEqual([]);
    d.record('danger');
    d.record('danger');
    expect(fired).toEqual([0]);
  });

  it('never fires when the threshold is below one ping', () => {
    const { d, fired } = detector({ threshold: () => 0 });
    for (let i = 0; i < 5; i++) d.record('danger');
    expect(fired).toEqual([]);
  });

  it('follows the trigger ping and the count as the settings change', () => {
    let ping: PingId = 'danger';
    let count = 2;
    const { d, fired } = detector({ ping: () => ping, threshold: () => count });
    d.record('missing'); // not the trigger ping yet, so it doesn't count
    ping = 'missing';
    d.record('missing');
    d.record('missing');
    expect(fired).toEqual([0]);
    count = 4;
    for (let i = 0; i < 3; i++) d.record('missing');
    expect(fired).toEqual([0]);
    d.record('missing');
    expect(fired).toEqual([0]);
  });
});
