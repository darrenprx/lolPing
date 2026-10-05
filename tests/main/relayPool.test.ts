import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeKeyPair, signEvent, type NostrEvent } from '../../src/main/nostrEvent';
import { RelayPool } from '../../src/main/relayPool';
import type { TransportStatus } from '../../src/main/transport';
import { fakeSockets, type FakeSocket } from './fixtures/fakeSocket';

const TOPIC = 'ab'.repeat(32);
const URLS = ['wss://a.test', 'wss://b.test', 'wss://c.test'];
const me = makeKeyPair();
const other = makeKeyPair();

let sockets: FakeSocket[];
let pool: RelayPool;
let events: NostrEvent[];
let statuses: TransportStatus[];
let linkUps: string[];

const ev = (keys = other, content = 'AAAA'): NostrEvent => signEvent(keys, 24747, [['x', TOPIC]], content, Math.floor(Date.now() / 1000));
/** The newest socket for a relay. */
const sock = (url: string): FakeSocket => sockets.filter((s) => s.url === url).at(-1)!;
const openAll = (): void => URLS.forEach((u) => sock(u).open());
const echoFrom = (url: string, e = ev(me)): void => sock(url).receive(['EVENT', 'lolping', e]);
const from = (url: string, e: NostrEvent): void => sock(url).receive(['EVENT', 'lolping', e]);

beforeEach(() => {
  vi.useFakeTimers({ now: 1_780_000_000_000 });
  const f = fakeSockets();
  sockets = f.sockets;
  pool = new RelayPool({ urls: URLS, topic: TOPIC, pubkey: me.pubkey, socket: f.factory, random: () => 0.5 });
  events = [];
  statuses = [];
  linkUps = [];
  pool.on('event', (e: NostrEvent) => events.push(e));
  pool.on('status', (s: TransportStatus) => statuses.push(s));
  pool.on('linkUp', (u: string) => linkUps.push(u));
});

afterEach(() => {
  pool.stop();
  vi.useRealTimers();
});

describe('RelayPool', () => {
  it('is off until started, then starting', () => {
    expect(pool.status).toBe('off');
    pool.start();
    expect(pool.status).toBe('starting');
    expect(sockets.map((s) => s.url)).toEqual(URLS);
  });

  it('publishes to live relays only, including a fresh one before its first echo', () => {
    pool.start();
    sock(URLS[0]).open();
    sock(URLS[1]).open();
    sock(URLS[1]).receive(['OK', 'e'.repeat(64), false, 'rate-limited: easy']);
    const e = ev(me);
    pool.publish(e);
    const sent = (url: string): unknown[][] => sock(url).messages().filter((m) => m[0] === 'EVENT');
    expect(sent(URLS[0])).toEqual([['EVENT', e]]);
    expect(sent(URLS[1])).toEqual([]); // cooling
    expect(sock(URLS[2]).sent).toEqual([]); // still connecting
  });

  it('goes starting → ok on the first echo → unavailable when no relay is healthy → ok again', () => {
    pool.start();
    openAll();
    echoFrom(URLS[0]);
    expect(pool.status).toBe('ok');
    sock(URLS[0]).drop();
    expect(pool.status).toBe('unavailable');
    vi.advanceTimersByTime(2000);
    sock(URLS[0]).open();
    echoFrom(URLS[0]);
    expect(pool.status).toBe('ok');
    expect(statuses).toEqual(['starting', 'ok', 'unavailable', 'ok']);
  });

  it('stays ok while any relay is healthy', () => {
    pool.start();
    openAll();
    echoFrom(URLS[0]);
    echoFrom(URLS[1]);
    sock(URLS[0]).drop();
    expect(pool.status).toBe('ok');
  });

  it('is unavailable after 15 s without any echo', () => {
    pool.start();
    openAll();
    vi.advanceTimersByTime(14_999);
    expect(pool.status).toBe('starting');
    vi.advanceTimersByTime(1);
    expect(pool.status).toBe('unavailable');
  });

  it('is unavailable as soon as every relay has failed to connect (no internet at all)', () => {
    pool.start();
    sock(URLS[0]).drop();
    sock(URLS[1]).drop();
    expect(pool.status).toBe('starting');
    sock(URLS[2]).drop();
    expect(pool.status).toBe('unavailable');
    vi.advanceTimersByTime(2000);
    sock(URLS[0]).open();
    echoFrom(URLS[0]);
    expect(pool.status).toBe('ok');
  });

  it('passes an event that arrives from several relays once', () => {
    pool.start();
    openAll();
    const e = ev();
    URLS.forEach((u) => from(u, e));
    expect(events).toEqual([e]);
  });

  it('forgets ids after 512 newer ones', () => {
    pool.start();
    openAll();
    const first = ev(other, 'first');
    from(URLS[0], first);
    for (let i = 0; i < 512; i++) {
      if (i % 100 === 0) vi.advanceTimersByTime(1000);
      from(URLS[0], ev(other, `n${i}`));
    }
    vi.advanceTimersByTime(1000);
    from(URLS[1], first);
    expect(events.filter((e) => e.id === first.id)).toHaveLength(2);
  });

  it('caps incoming events at 200 per second across relays', () => {
    pool.start();
    openAll();
    for (let i = 0; i < 150; i++) from(URLS[0], ev(other, `a${i}`));
    for (let i = 0; i < 100; i++) from(URLS[1], ev(other, `b${i}`));
    expect(events).toHaveLength(200);
    vi.advanceTimersByTime(1000);
    from(URLS[2], ev(other, 'later'));
    expect(events).toHaveLength(201);
  });

  it('does not count duplicates against the budget', () => {
    pool.start();
    openAll();
    const e = ev();
    for (let i = 0; i < 300; i++) from(URLS[i % 3], e);
    from(URLS[0], ev(other, 'new'));
    expect(events).toHaveLength(2);
  });

  it('emits linkUp each time a relay goes live', () => {
    pool.start();
    openAll();
    sock(URLS[1]).drop();
    vi.advanceTimersByTime(2000);
    sock(URLS[1]).open();
    expect(linkUps).toEqual([...URLS, URLS[1]]);
  });

  it('forwards OK results', () => {
    const ok = vi.fn();
    pool.on('ok', ok);
    pool.start();
    sock(URLS[0]).open();
    sock(URLS[0]).receive(['OK', 'e'.repeat(64), true, '']);
    expect(ok).toHaveBeenCalledWith('e'.repeat(64), true);
  });

  it('retryNow during backoff keeps one socket per relay', () => {
    pool.start();
    sockets.forEach((s) => s.drop());
    pool.retryNow();
    pool.retryNow();
    pool.retryNow();
    vi.advanceTimersByTime(120_000);
    for (const u of URLS) expect(sockets.filter((s) => s.url === u && !s.closed)).toHaveLength(1);
  });

  it('retryNow revives retired relays; wake does not', () => {
    pool.start();
    openAll();
    sock(URLS[0]).receive(['OK', 'e'.repeat(64), false, 'blocked: no']);
    const count = (): number => sockets.filter((s) => s.url === URLS[0]).length;
    pool.wake();
    expect(count()).toBe(1);
    pool.retryNow();
    expect(count()).toBe(2);
  });

  it('wake reconnects every relay that is not retired', () => {
    pool.start();
    openAll();
    pool.wake();
    expect(sockets).toHaveLength(6);
    expect(sockets.slice(0, 3).every((s) => s.closed)).toBe(true);
  });

  it('stop closes every socket and emits nothing afterwards', () => {
    pool.start();
    openAll();
    const n = statuses.length + events.length + linkUps.length;
    pool.stop();
    expect(sockets.every((s) => s.closed)).toBe(true);
    from(URLS[0], ev());
    vi.advanceTimersByTime(600_000);
    expect(statuses.length + events.length + linkUps.length).toBe(n);
    expect(pool.status).toBe('off');
  });
});
