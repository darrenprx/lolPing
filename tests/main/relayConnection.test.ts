import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeKeyPair, signEvent, type NostrEvent } from '../../src/main/nostrEvent';
import { RelayConnection, type RelayState } from '../../src/main/relayConnection';
import { fakeSockets, type FakeSocket } from './fixtures/fakeSocket';

const NOW = 1_780_000_000_000;
const TOPIC = 'ab'.repeat(32);
const me = makeKeyPair();
const other = makeKeyPair();

let sockets: FakeSocket[];
let conn: RelayConnection;
let events: NostrEvent[];
let echoes: number;
let states: RelayState[];

const ev = (keys = other, kind = 24747, topic = TOPIC): NostrEvent =>
  signEvent(keys, kind, [['x', topic]], 'AAAA', Math.floor(Date.now() / 1000));
const last = (): FakeSocket => sockets[sockets.length - 1];
/** Opens the newest socket: the connection subscribes and goes live. */
const goLive = (): FakeSocket => {
  last().open();
  return last();
};
const echo = (): void => last().receive(['EVENT', 'lolping', ev(me)]);
const published = (s: FakeSocket): unknown[][] => s.messages().filter((m) => m[0] === 'EVENT');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  const f = fakeSockets();
  sockets = f.sockets;
  conn = new RelayConnection({ url: 'wss://r.test', topic: TOPIC, pubkey: me.pubkey, socket: f.factory, random: () => 0.5 });
  events = [];
  echoes = 0;
  states = [];
  conn.on('event', (e: NostrEvent) => events.push(e));
  conn.on('echo', () => echoes++);
  conn.on('state', (s: RelayState) => states.push(s));
  conn.start();
});

afterEach(() => {
  conn.stop();
  vi.useRealTimers();
});

describe('RelayConnection', () => {
  it('opens, subscribes and goes live', () => {
    const live = vi.fn();
    conn.on('live', live);
    expect(conn.state).toBe('connecting');
    const s = goLive();
    expect(s.messages()[0]).toEqual(['REQ', 'lolping', { kinds: [24747], '#x': [TOPIC], since: NOW / 1000 - 600, limit: 0 }]);
    expect(conn.state).toBe('live');
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('publishes only while live', () => {
    conn.publish('["EVENT",1]');
    const s = goLive();
    conn.publish('["EVENT",2]');
    expect(s.sent.slice(1)).toEqual(['["EVENT",2]']);
  });

  it("separates echoes from other members' events, and ignores other subscriptions, kinds and topics", () => {
    const s = goLive();
    const theirs = ev();
    s.receive(['EVENT', 'lolping', theirs]);
    echo();
    s.receive(['EVENT', 'other-sub', ev()]);
    s.receive(['EVENT', 'lolping', ev(other, 1)]);
    s.receive(['EVENT', 'lolping', ev(other, 24747, 'cd'.repeat(32))]);
    s.receive('["NOTICE","hi"]');
    s.receive('garbage');
    expect(events).toEqual([theirs]);
    expect(echoes).toBe(1);
  });

  it('is healthy after the first echo, and down after 25 s without one', () => {
    goLive();
    expect(conn.healthy).toBe(false);
    echo();
    expect(conn.healthy).toBe(true);
    vi.advanceTimersByTime(24_999);
    expect(conn.state).toBe('live');
    vi.advanceTimersByTime(1);
    expect(conn.state).toBe('down');
    expect(conn.healthy).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it('a silent socket is closed and reconnected after 25 s without an echo', () => {
    const s = goLive();
    vi.advanceTimersByTime(25_000);
    expect(s.closed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
    goLive();
    expect(conn.state).toBe('live');
  });

  it('backs off 2, 4, 8 … up to 60 s, and resets after 60 s healthy', () => {
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      last().drop();
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    goLive();
    echo();
    for (let t = 0; t < 60_000; t += 10_000) {
      vi.advanceTimersByTime(10_000);
      echo();
    }
    last().drop();
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(9);
  });

  it("counts a socket that hasn't opened within 10 s as down", () => {
    vi.advanceTimersByTime(9999);
    expect(conn.state).toBe('connecting');
    vi.advanceTimersByTime(1);
    expect(conn.state).toBe('down');
    expect(sockets[0].closed).toBe(true);
  });

  it("rate-limited: cools for 30 s, publishes nothing, and isn't marked down for missing echoes", () => {
    const s = goLive();
    echo();
    s.receive(['OK', 'e'.repeat(64), false, 'rate-limited: slow down']);
    expect(conn.state).toBe('cooling');
    conn.publish('["EVENT",3]');
    expect(published(s)).toEqual([]);
    vi.advanceTimersByTime(29_999);
    expect(conn.state).toBe('cooling');
    vi.advanceTimersByTime(1);
    expect(conn.state).toBe('live');
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(25_000);
    expect(conn.state).toBe('down');
  });

  it.each(['blocked:', 'restricted:', 'auth-required:', 'pow:', 'invalid:'])('retires on %s', (prefix) => {
    const s = goLive();
    s.receive(['OK', 'e'.repeat(64), false, `${prefix} no`]);
    expect(conn.state).toBe('retired');
    expect(s.closed).toBe(true);
    vi.advanceTimersByTime(600_000);
    expect(sockets).toHaveLength(1);
    conn.reconnectNow(true);
    expect(sockets).toHaveLength(2);
  });

  it('emits OK results', () => {
    const ok = vi.fn();
    conn.on('ok', ok);
    goLive().receive(['OK', 'e'.repeat(64), true, '']);
    expect(ok).toHaveBeenCalledWith('e'.repeat(64), true, '');
  });

  it('resubscribes after one CLOSED and retires after a second', () => {
    const s = goLive();
    s.receive(['CLOSED', 'lolping', 'error: restarting']);
    expect(s.messages().filter((m) => m[0] === 'REQ')).toHaveLength(2);
    expect(conn.state).toBe('live');
    s.receive(['CLOSED', 'lolping', 'error: restarting']);
    expect(conn.state).toBe('retired');
  });

  it('retires after a message over 64 KB', () => {
    goLive().receive('x'.repeat(64 * 1024 + 1));
    expect(conn.state).toBe('retired');
  });

  it('retires after more than 400 messages in one second', () => {
    const s = goLive();
    for (let i = 0; i < 400; i++) s.receive('["NOTICE","x"]');
    expect(conn.state).toBe('live');
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 400; i++) s.receive('["NOTICE","x"]');
    expect(conn.state).toBe('live');
    s.receive('["NOTICE","x"]');
    expect(conn.state).toBe('retired');
  });

  it('retires after a binary frame, which no Nostr relay sends', () => {
    const s = goLive();
    s.onmessage?.({ data: new Uint8Array(10 * 1024 * 1024) });
    expect(conn.state).toBe('retired');
  });

  it('reconnectNow(true) leaves connecting and live relays alone, so pressing Retry again never undoes a connection', () => {
    conn.reconnectNow(true);
    expect(sockets).toHaveLength(1);
    goLive();
    conn.reconnectNow(true);
    expect(sockets).toHaveLength(1);
    last().drop();
    conn.reconnectNow(true);
    expect(sockets).toHaveLength(2);
  });

  it('reconnectNow(false) skips the backoff but leaves a retired relay alone', () => {
    last().drop();
    expect(sockets).toHaveLength(1);
    conn.reconnectNow(false);
    expect(sockets).toHaveLength(2);
    goLive().receive(['OK', 'e'.repeat(64), false, 'blocked: go away']);
    conn.reconnectNow(false);
    expect(sockets).toHaveLength(2);
  });

  it('stop() closes the socket and emits nothing afterwards', () => {
    const s = goLive();
    const before = states.length;
    conn.stop();
    expect(s.closed).toBe(true);
    s.receive(['EVENT', 'lolping', ev()]);
    s.onclose?.();
    vi.advanceTimersByTime(600_000);
    expect(events).toEqual([]);
    expect(states).toHaveLength(before);
    expect(sockets).toHaveLength(1);
  });
});
