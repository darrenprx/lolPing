// Checks which public Nostr relays can carry room traffic: they must accept our ephemeral event kind, send our own
// events back quickly, take a burst at the ping cap without rate-limiting us, and stay up between presences.
// Each relay gets its own throwaway key and random topic; the content is random bytes the size of a real packet.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  eventMessage, makeKeyPair, parseRelayMessage, reqMessage, ROOM_EVENT_KIND, signEvent,
} from '../../src/main/nostrEvent';

const CANDIDATES = [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://offchain.pub',
  'wss://relay.nostr.net', 'wss://nostr.oxtr.dev', 'wss://relay.snort.social', 'wss://nostr-pub.wellorder.net',
  'wss://nostr.bitcoiner.social', 'wss://relay.nostr.bg', 'wss://relay.agentry.com', 'wss://relay.layer.systems',
  'wss://nostr.stakey.net', 'wss://relay.routstr.com', 'wss://nostr.rblb.it',
];
const CONNECT_LIMIT_MS = 5000;
const CONNECT_GIVE_UP_MS = 10_000;
const ROUND_TRIPS = 20;
const ROUND_TRIP_GAP_MS = 500;
const BURST_SECONDS = 30;
const SOAK_GAP_MS = 10_000;
const SETTLE_MS = 3000;
const SUB = 'probe';

const { values } = parseArgs({
  options: {
    relays: { type: 'string' },
    'burst-rate': { type: 'string', default: '5' },
    'soak-min': { type: 'string', default: '10' },
  },
});
const urls = values.relays ? values.relays.split(',').map((u) => u.trim()).filter(Boolean) : CANDIDATES;
const burstRate = Number(values['burst-rate']);
const soakMs = Number(values['soak-min']) * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const percentile = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

interface Phase { sent: number; echoed: number; rateLimited: number; rejected: number }
interface Result {
  url: string;
  connectMs: number | null;
  accepted: boolean;
  rejectMessage: string;
  medianMs: number | null;
  p95Ms: number | null;
  burst: Phase;
  soak: Phase & { closes: number; reconnectFailures: number };
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
}

async function probe(url: string): Promise<Result> {
  const keys = makeKeyPair();
  const topic = randomBytes(32).toString('hex');
  const host = new URL(url).host;
  const log = (s: string): void => console.log(`[${host}] ${s}`);
  const sentAt = new Map<string, { at: number; phase: 'rtt' | 'burst' | 'soak' }>();
  const echoed = new Set<string>();
  const rtts: number[] = [];
  const phases: Record<'rtt' | 'burst' | 'soak', Phase> = {
    rtt: { sent: 0, echoed: 0, rateLimited: 0, rejected: 0 },
    burst: { sent: 0, echoed: 0, rateLimited: 0, rejected: 0 },
    soak: { sent: 0, echoed: 0, rateLimited: 0, rejected: 0 },
  };
  const result: Result = {
    url, connectMs: null, accepted: false, rejectMessage: '', medianMs: null, p95Ms: null,
    burst: phases.burst, soak: { ...phases.soak, closes: 0, reconnectFailures: 0 }, verdict: 'FAIL', reasons: [],
  };
  let ws: WebSocket | null = null;
  let closedByUs = false;

  const connect = (): Promise<number | null> => new Promise((resolve) => {
    const started = Date.now();
    const socket = new WebSocket(url);
    ws = socket;
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, CONNECT_GIVE_UP_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.send(reqMessage(SUB, topic, Math.floor(Date.now() / 1000) - 600));
      resolve(Date.now() - started);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      clearTimeout(timer);
      if (ws !== socket) return;
      ws = null;
      if (!closedByUs) result.soak.closes++;
      resolve(null);
    };
    socket.onmessage = (ev) => {
      const m = parseRelayMessage(String(ev.data));
      if (!m) return;
      if (m.type === 'OK') {
        const s = sentAt.get(m.eventId);
        if (!s || m.ok) {
          if (m.ok) result.accepted = true;
          return;
        }
        if (m.message.startsWith('rate-limited:')) phases[s.phase].rateLimited++;
        else {
          phases[s.phase].rejected++;
          result.rejectMessage ||= m.message;
        }
      } else if (m.type === 'EVENT' && m.subId === SUB && m.event.pubkey === keys.pubkey) {
        const s = sentAt.get(m.event.id);
        if (!s || echoed.has(m.event.id)) return;
        echoed.add(m.event.id);
        phases[s.phase].echoed++;
        if (s.phase === 'rtt') rtts.push(Date.now() - s.at);
      } else if (m.type === 'CLOSED' || m.type === 'NOTICE') {
        log(`${m.type}: ${m.message}`);
      }
    };
  });

  const publish = (phase: 'rtt' | 'burst' | 'soak'): void => {
    const content = randomBytes(1200).toString('base64');
    const e = signEvent(keys, ROOM_EVENT_KIND, [['x', topic]], content, Math.floor(Date.now() / 1000));
    sentAt.set(e.id, { at: Date.now(), phase });
    phases[phase].sent++;
    const socket = ws as WebSocket | null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(eventMessage(e));
  };

  result.connectMs = await connect();
  if (result.connectMs === null) {
    result.reasons.push('could not connect');
    log('could not connect');
    return result;
  }
  log(`connected in ${result.connectMs} ms`);

  for (let i = 0; i < ROUND_TRIPS; i++) {
    publish('rtt');
    await sleep(ROUND_TRIP_GAP_MS);
  }
  await sleep(SETTLE_MS);
  result.medianMs = percentile(rtts, 50);
  result.p95Ms = percentile(rtts, 95);
  log(`round trips: ${rtts.length}/${ROUND_TRIPS} echoed, median ${result.medianMs ?? '-'} ms, p95 ${result.p95Ms ?? '-'} ms`);

  for (let i = 0; i < BURST_SECONDS * burstRate; i++) {
    publish('burst');
    await sleep(1000 / burstRate);
  }
  await sleep(SETTLE_MS);
  log(`burst: ${phases.burst.echoed}/${phases.burst.sent} echoed, ${phases.burst.rateLimited} rate-limited`);

  const soakEnd = Date.now() + soakMs;
  while (Date.now() < soakEnd) {
    if (!ws) {
      if ((await connect()) === null) result.soak.reconnectFailures++;
      else log('reconnected');
    }
    publish('soak');
    await sleep(SOAK_GAP_MS);
  }
  if (soakMs > 0) {
    await sleep(SETTLE_MS);
    log(`soak: ${phases.soak.echoed}/${phases.soak.sent} echoed, ${result.soak.closes} closes`);
  }
  Object.assign(result.soak, phases.soak);
  closedByUs = true;
  (ws as WebSocket | null)?.close();

  const r = result.reasons;
  if (result.connectMs > CONNECT_LIMIT_MS) r.push(`connect ${result.connectMs} ms > ${CONNECT_LIMIT_MS}`);
  if (!result.accepted) r.push(`not accepted${result.rejectMessage ? `: ${result.rejectMessage}` : ''}`);
  if (result.medianMs === null || result.medianMs > 1000) r.push(`median ${result.medianMs ?? 'none'} > 1000 ms`);
  if (result.p95Ms === null || result.p95Ms > 2000) r.push(`p95 ${result.p95Ms ?? 'none'} > 2000 ms`);
  if (phases.burst.rateLimited > 0) r.push(`burst rate-limited ×${phases.burst.rateLimited}`);
  if (phases.burst.sent > 0 && phases.burst.echoed / phases.burst.sent < 0.99) r.push(`burst echoed ${phases.burst.echoed}/${phases.burst.sent}`);
  if (result.soak.reconnectFailures > 0) r.push(`soak reconnect failed ×${result.soak.reconnectFailures}`);
  result.verdict = r.length === 0 ? 'PASS' : 'FAIL';
  return result;
}

console.log(`Probing ${urls.length} relays: burst ${burstRate}/s for ${BURST_SECONDS} s, soak ${values['soak-min']} min.`);
const results = await Promise.all(urls.map(probe));
const pct = (p: Phase): string => (p.sent ? `${Math.round((100 * p.echoed) / p.sent)}%` : '-');
console.log('\n' + ['relay', 'connect', 'median', 'p95', 'burst', 'limited', 'soak', 'closes', 'verdict'].join('\t'));
for (const r of results) {
  console.log([
    new URL(r.url).host, r.connectMs ?? '-', r.medianMs ?? '-', r.p95Ms ?? '-', pct(r.burst), r.burst.rateLimited,
    pct(r.soak), r.soak.closes, r.verdict + (r.reasons.length ? ` (${r.reasons.join('; ')})` : ''),
  ].join('\t'));
}
const report = join(tmpdir(), 'lolping-relay-probe.json');
writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), burstRate, soakMin: Number(values['soak-min']), results }, null, 2));
console.log(`\n${results.filter((r) => r.verdict === 'PASS').length}/${results.length} passed. Report: ${report}`);
process.exit(0);
