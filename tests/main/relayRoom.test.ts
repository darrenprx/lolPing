import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanTransport } from '../../src/main/lanTransport';
import { RelayTransport } from '../../src/main/relayTransport';
import { deriveRoomKeys } from '../../src/main/roomCrypto';
import { RoomManager, type RemotePing, type RoomToast } from '../../src/main/roomManager';
import type { Transport } from '../../src/main/transport';
import { makeRoomCode } from '../../src/shared/roomCode';
import { startFakeRelay } from './fixtures/fakeRelay';

// Two rooms in one process meeting through a relay on loopback, the way two computers meet through a public one.
const CODE = makeRoomCode(randomBytes(9));

async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function peer(name: string, transports: Transport[]) {
  const room = new RoomManager({
    transports,
    now: Date.now,
    randomBytes: (n) => randomBytes(n),
    deriveKeys: deriveRoomKeys,
    appVersion: '0.4.0',
    profile: () => ({ name, color: 2, limit: 0 }),
    resolveTarget: () => ({ displayId: 1, width: 1000, height: 500 }),
  });
  const pings: RemotePing[] = [];
  const toasts: RoomToast[] = [];
  room.on('remotePing', (p: RemotePing) => pings.push(p));
  room.on('toast', (t: RoomToast) => toasts.push(t));
  return { room, pings, toasts, transports };
}

let relay: Awaited<ReturnType<typeof startFakeRelay>>;
let peers: ReturnType<typeof peer>[];

beforeEach(async () => {
  relay = await startFakeRelay();
  peers = [];
});

afterEach(async () => {
  for (const p of peers) p.room.quit();
  await Promise.all(peers.flatMap((p) => p.transports.map((t) => t.whenClosed())));
  await relay.close();
});

describe('rooms over a relay', () => {
  it('two rooms meet over a relay, exchange a ping, and see bye', async () => {
    const a = peer('Ana', [new RelayTransport({ urls: [relay.url] })]);
    const b = peer('Ben', [new RelayTransport({ urls: [relay.url] })]);
    peers.push(a, b);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    await until(() => a.room.state().members.length === 2 && b.room.state().members.length === 2);
    expect(a.room.state().members[1]).toMatchObject({ name: 'Ben', path: 'internet' });
    expect(a.room.state().internet).toBe('ok');

    b.room.sendPing('omw', { d: 1, x: 0.25, y: 0.5 });
    await until(() => a.pings.length === 1);
    expect(a.pings[0]).toMatchObject({ id: 'omw', x: 250, y: 250, tag: { name: 'Ben', color: 2 } });

    b.room.leave();
    await until(() => a.toasts.some((t) => t.kind === 'left'));
    expect(a.room.state().members).toHaveLength(1);
  }, 20_000);

  it('switches a member to the internet path when LAN stops', async () => {
    const lanA = new LanTransport({ port: 47_511, bindAddress: '127.0.0.1', broadcast: false, seeds: [{ host: '127.0.0.1', port: 47_512 }] });
    const lanB = new LanTransport({ port: 47_512, bindAddress: '127.0.0.1', broadcast: false, seeds: [{ host: '127.0.0.1', port: 47_511 }] });
    const a = peer('Ana', [lanA, new RelayTransport({ urls: [relay.url] })]);
    const b = peer('Ben', [lanB, new RelayTransport({ urls: [relay.url] })]);
    peers.push(a, b);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    await until(() => a.room.state().members[1]?.path === 'lan');

    lanB.stop();
    await until(() => a.room.state().members[1]?.path === 'internet', 8000);
  }, 20_000);
});
