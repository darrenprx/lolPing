// A fake room member for trying rooms with one computer: it announces itself, pings at random spots and prints
// the pings it receives. It speaks the real protocol, using the app's own modules.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { LanTransport } from '../../src/main/lanTransport';
import { RelayTransport } from '../../src/main/relayTransport';
import { deriveRoomKeys, open, seal } from '../../src/main/roomCrypto';
import { RELAY_PING_RATE } from '../../src/main/roomManager';
import type { Transport } from '../../src/main/transport';
import { ALL_PINGS } from '../../src/shared/pings';
import { parseRoomCode } from '../../src/shared/roomCode';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, type RoomMessage } from '../../src/shared/roomProtocol';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string', default: 'Bot' },
    color: { type: 'string', default: '4' },
    rate: { type: 'string', default: '1' }, // pings per second; 0 = only listen
    host: { type: 'string', default: '127.0.0.1' }, // where lolPing runs
    port: { type: 'string', default: '47475' }, // this peer's own port (lolPing itself uses 47474)
    display: { type: 'string', default: '1' },
    relay: { type: 'boolean', default: false }, // through the public relays instead of the LAN
  },
});

const parsed = parseRoomCode(positionals.join(' '));
if (!parsed.ok) {
  console.error('usage: node tools/room-peer/run.mjs PING-XXXXX-XXXXX [--name Bot] [--color 0-7] [--rate 1] [--host 127.0.0.1] [--port 47475] [--display 1] [--relay]');
  process.exit(1);
}

const keys = await deriveRoomKeys(parsed.code);
const peer = randomBytes(8).toString('hex');
let seq = 0;
const packet = (body: Record<string, unknown>): Buffer =>
  seal(keys.msgKey, encodeMessage({ peer, seq: ++seq, ts: Date.now(), ...body } as RoomMessage));
const presence = (): Buffer =>
  packet({ t: 'presence', proto: PROTOCOL_VERSION, app: 'room-peer', name: values.name, color: Number(values.color), status: 'on' });

const transport: Transport = values.relay
  ? new RelayTransport()
  : new LanTransport({ port: Number(values.port), seeds: [{ host: values.host!, port: 47474 }] });
const label = values.relay ? 'relay' : 'lan';
transport.on('status', (s) => console.log(`[${label}] ${s}`));
transport.on('packet', (from: string, data: Uint8Array) => {
  const plain = open(keys.msgKey, data);
  const msg = plain && decodeMessage(plain);
  if (!msg || msg.peer === peer) return;
  if (msg.t === 'ping') console.log(`[in] ${msg.ping} on display ${msg.d} at ${msg.x}, ${msg.y} from ${from}`);
  else if (msg.t === 'presence') console.log(`[in] presence: ${msg.name} (${msg.status})`);
  else console.log(`[in] bye from ${msg.peer}`);
});
transport.start(keys);

setInterval(() => transport.broadcast(presence()), values.relay ? 10_000 : 2000);
if (values.relay) transport.on('linkUp', () => transport.broadcast(presence())); // each relay as it comes up
else transport.once('status', () => transport.broadcast(presence()));
let rate = Number(values.rate);
if (values.relay && rate > RELAY_PING_RATE) {
  console.log(`[relay] --rate ${rate} is more than the relays should get; using ${RELAY_PING_RATE}`);
  rate = RELAY_PING_RATE;
}
if (rate > 0) {
  setInterval(() => {
    const ping = ALL_PINGS[Math.floor(Math.random() * ALL_PINGS.length)].id;
    const [x, y] = [0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8];
    transport.broadcast(packet({ t: 'ping', ping, d: Number(values.display), x, y }));
    console.log(`[out] ${ping} at ${x.toFixed(2)}, ${y.toFixed(2)}`);
  }, 1000 / rate);
}
console.log(`room-peer "${values.name}" in room ${positionals.join(' ')} over ${values.relay ? 'the relays' : 'the LAN'} — Ctrl+C to leave`);
process.on('SIGINT', () => {
  transport.broadcast(packet({ t: 'bye' }));
  transport.stop();
  void transport.whenClosed().then(() => process.exit(0));
});
