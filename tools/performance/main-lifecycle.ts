import { ChildProcess } from 'node:child_process';
import { EventEmitter, on, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InputBridge } from '../../src/main/inputBridge';
import { RateLimiter } from '../../src/main/rateLimiter';
import { RestartPolicy } from '../../src/main/restartPolicy';
import { RoomManager } from '../../src/main/roomManager';
import { makeIdentity, peerIdOf, seal, signBody, type RoomKeys } from '../../src/main/roomCrypto';
import { SettingsStore } from '../../src/main/settingsStore';
import type { PeerKey, Transport, TransportStatus } from '../../src/main/transport';
import { configCommand, type HelperEvent } from '../../src/shared/protocol';
import { makeRoomCode } from '../../src/shared/roomCode';
import { encodeMessage, joinSigned, type RoomMessage } from '../../src/shared/roomProtocol';
import { platformOf } from '../../src/shared/platform';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

const root = resolve(process.argv[2] ?? '.');
const helper = join(root, 'native/hook-helper/build', process.platform === 'win32' ? 'hook-helper.exe' : 'hook-helper');
const bridges: InputBridge[] = [];

function nextEvent(bridge: InputBridge, type: HelperEvent['type']): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.off('event', receive);
      reject(new Error(`helper did not emit ${type}`));
    }, 5000);
    const receive = (event: HelperEvent): void => {
      if (event.type !== type) return;
      clearTimeout(timer);
      bridge.off('event', receive);
      resolve();
    };
    bridge.on('event', receive);
  });
}

/** Access the real pipe to send simulation input and reproduce stdout arriving after the exit event. */
function childOf(bridge: InputBridge): ChildProcess {
  const child: unknown = Reflect.get(bridge, 'child');
  if (!(child instanceof ChildProcess)) throw new Error('helper child is absent');
  return child;
}

function writeSimulation(bridge: InputBridge, command: Record<string, unknown>): void {
  const input = childOf(bridge).stdin;
  if (!input?.writable) throw new Error('helper stdin is unavailable');
  input.write(`${JSON.stringify(command)}\n`);
}

async function simulate(bridge: InputBridge, ev: string, fields: Record<string, unknown> = {}): Promise<void> {
  // The sim reply is an ordering barrier for the helper commands written before this input.
  const finished = nextEvent(bridge, 'sim');
  writeSimulation(bridge, { type: 'sim', ev, ...fields });
  await finished;
}

async function start(bridge: InputBridge): Promise<void> {
  bridges.push(bridge);
  const ready = nextEvent(bridge, 'ready');
  bridge.start();
  await ready;
}

async function drag(bridge: InputBridge, key = 164): Promise<void> {
  await simulate(bridge, 'kdown', { vk: key });
  await simulate(bridge, 'mdown', { btn: 'left', x: 100, y: 100 });
  await simulate(bridge, 'move', { x: 140, y: 100 });
}

async function release(bridge: InputBridge, key = 164): Promise<void> {
  await simulate(bridge, 'mup', { btn: 'left', x: 140, y: 100 });
  await simulate(bridge, 'kup', { vk: key });
}

async function settingsLifecycle(directory: string): Promise<void> {
  const store = new SettingsStore(directory, 300, platformOf(process.platform));
  store.load();
  const bridge = new InputBridge({ command: helper, args: ['--simulate'] });
  const events: HelperEvent[] = [];
  bridge.on('event', (event: HelperEvent) => events.push(event));
  store.on('change', (settings) => bridge.send(configCommand(settings, true)));
  bridge.send(configCommand(store.get(), true));
  await start(bridge);
  try {
    await drag(bridge);
    store.update({ updateNotifiedVersion: '0.5.2' });
    await simulate(bridge, 'move', { x: 150, y: 100 });
    await release(bridge);
    if (events.some((event) => event.type === 'cancel') || !events.some((event) => event.type === 'wheelRelease')) {
      throw new Error('background settings update interrupted the gesture');
    }

    events.length = 0;
    await drag(bridge);
    store.update({ dragThresholdPx: 12 });
    await simulate(bridge, 'move', { x: 150, y: 100 });
    if (events.filter((event) => event.type === 'cancel').length !== 1) throw new Error('changed input config did not cancel the gesture');
    await release(bridge);

    events.length = 0;
    bridge.send({ type: 'setEnabled', enabled: false });
    bridge.send(configCommand(store.get(), true));
    await drag(bridge);
    if (!events.some((event) => event.type === 'wheelOpen')) throw new Error('same config did not restore enabled after setEnabled');
    await release(bridge);

    events.length = 0;
    for (const vk of [162, 164, 80]) await simulate(bridge, 'kdown', { vk });
    for (const vk of [80, 164, 162]) await simulate(bridge, 'kup', { vk });
    if (!events.some((event) => event.type === 'toggled' && !event.enabled)) throw new Error('native shortcut did not disable input');
    bridge.send(configCommand(store.get(), true));
    await drag(bridge);
    if (!events.some((event) => event.type === 'wheelOpen')) throw new Error('same config did not restore enabled after native toggle');
    await release(bridge);
    console.log(JSON.stringify({ scenario: 'settings and enabled lifecycle', backgroundGesture: 'released', changedConfig: 'cancelled', enabledRestored: ['command', 'shortcut'] }));
  } finally {
    await bridge.stop();
    await store.flush();
  }
  const reloaded = new SettingsStore(directory);
  const persisted = reloaded.load();
  if (persisted.updateNotifiedVersion !== '0.5.2' || persisted.dragThresholdPx !== 12) throw new Error('settings did not survive reload');
  await reloaded.flush();
}

async function restartConfig(): Promise<void> {
  const bridge = new InputBridge({ command: helper, args: ['--simulate'], policy: new RestartPolicy([0], 3) });
  const config = configCommand({ ...DEFAULT_SETTINGS, trigger: 'ctrl', clickPing: true, emoteTrigger: 'off' }, true);
  if (config.type !== 'config') throw new Error('settings did not produce a helper config');
  bridge.send(config);
  await start(bridge);
  try {
    // The caller still owns its object; mutating it must not change the bridge's restart snapshot.
    config.clickPing = false;
    const ready = nextEvent(bridge, 'ready');
    writeSimulation(bridge, { type: 'shutdown' });
    await ready;
    const clicked = nextEvent(bridge, 'click');
    await simulate(bridge, 'kdown', { vk: 162 });
    await simulate(bridge, 'mdown', { btn: 'left', x: 100, y: 100 });
    await simulate(bridge, 'mup', { btn: 'left', x: 100, y: 100 });
    await clicked;
    await simulate(bridge, 'kup', { vk: 162 });
    console.log(JSON.stringify({ scenario: 'helper restart', trigger: 'ctrl', clickPing: true, callerMutationIgnored: true }));
  } finally {
    await bridge.stop();
  }
}

async function toggleDuringSettingsChange(directory: string): Promise<void> {
  const store = new SettingsStore(directory, 300, platformOf(process.platform));
  store.load();
  const bridge = new InputBridge({ command: helper, args: ['--simulate'] });
  let enabled = true;
  const events: HelperEvent[] = [];
  // Same synchronous ownership as main: a native toggle updates enabled, then sends the current settings.
  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    bridge.send(configCommand(store.get(), enabled));
  }
  bridge.on('event', (event: HelperEvent) => {
    events.push(event);
    if (event.type === 'toggled') setEnabled(event.enabled);
  });
  store.on('change', (settings) => bridge.send(configCommand(settings, enabled)));
  bridge.send(configCommand(store.get(), enabled));
  await start(bridge);
  try {
    const child = childOf(bridge);
    child.stdout?.pause();
    const replies = on(bridge, 'event', { signal: AbortSignal.timeout(5000) });
    for (const vk of [162, 164, 80]) writeSimulation(bridge, { type: 'sim', ev: 'kdown', vk });
    for (const vk of [80, 164, 162]) writeSimulation(bridge, { type: 'sim', ev: 'kup', vk });
    store.update({ dragThresholdPx: 12 });
    child.stdout?.resume();
    let remaining = 6;
    for await (const [event] of replies) if (event.type === 'sim' && --remaining === 0) break;
    await simulate(bridge, 'kup', { vk: 80 });
    events.length = 0;
    await drag(bridge);
    if (enabled || events.some((event) => event.type === 'wheelOpen')) throw new Error('buffered native toggle left main and helper enabled states inconsistent');
    await release(bridge);
    setEnabled(true);
    await drag(bridge);
    if (!events.some((event) => event.type === 'wheelOpen')) throw new Error('input did not recover after the interleaved toggle');
    await release(bridge);
    console.log(JSON.stringify({ scenario: 'toggle interleaved with settings', disabledGestureOpened: false, enabledRestored: true }));
  } finally {
    await bridge.stop();
    await store.flush();
  }
}

async function tailOutput(): Promise<void> {
  const bridge = new InputBridge({ command: helper, args: ['--simulate'], policy: new RestartPolicy([0], 1) });
  await start(bridge);
  let lateInputs = 0;
  bridge.on('event', (event: HelperEvent) => { if (event.type !== 'error') lateInputs++; });
  const child = childOf(bridge);
  child.stdout?.pause();
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  for (const command of [
    { type: 'sim', ev: 'kdown', vk: 164 },
    { type: 'sim', ev: 'mdown', btn: 'left', x: 100, y: 100 },
    { type: 'sim', ev: 'move', x: 140, y: 100 },
    { type: 'shutdown' },
  ]) writeSimulation(bridge, command);
  await closed;
  if (bridge.status !== 'failed' || lateInputs !== 0) throw new Error(`retired helper delivered ${lateInputs} inputs with status ${bridge.status}`);

  const diagnosticSource = `
    process.stdout.write('{"type":"ready","version":2}\\n');
    process.stdin.once('data', () => {
      const tail = [
        { type: 'ready', version: 2 }, { type: 'toggled', enabled: false },
        { type: 'wheelOpen', x: 1, y: 2, wheel: 'ping' }, { type: 'sim', swallow: false, inject: '' },
        { type: 'error', code: 'noAccess', message: 'permission unavailable' }
      ];
      process.stdout.write(tail.map(value => JSON.stringify(value) + '\\n').join(''), () => process.exit(3));
    });
  `;
  const diagnostic = new InputBridge({ command: process.execPath, args: ['-e', diagnosticSource] });
  await start(diagnostic);
  const tail: HelperEvent[] = [];
  diagnostic.on('event', (event: HelperEvent) => tail.push(event));
  const producer = childOf(diagnostic);
  producer.stdout?.pause();
  const diagnosticClosed = once(producer, 'close', { signal: AbortSignal.timeout(5000) });
  diagnostic.send({ type: 'setEnabled', enabled: true });
  await diagnosticClosed;
  if (diagnostic.status !== 'noAccess' || tail.length !== 1 || tail[0].type !== 'error' || tail[0].code !== 'noAccess') {
    throw new Error('retired helper lost its diagnostic or revived its state');
  }
  console.log(JSON.stringify({ scenario: 'helper output after exit', lateInputs, diagnostics: tail.length, status: diagnostic.status }));
}

/** A controlled packet boundary: production RoomManager, authenticated packets and replay checks remain in use. */
class RoomTransport extends EventEmitter implements Transport {
  readonly kind = 'lan';
  readonly shared = false;
  status: TransportStatus = 'off';
  start(_keys: RoomKeys): void { this.status = 'ok'; this.emit('status', this.status); }
  stop(): void { this.status = 'off'; this.emit('status', this.status); }
  sendTo(_peer: PeerKey, _packet: Uint8Array): void {}
  broadcast(_packet: Uint8Array): void {}
  whenClosed(): Promise<void> { return Promise.resolve(); }
}

async function roomLifecycle(): Promise<void> {
  const transport = new RoomTransport();
  const keys = { msgKey: Buffer.alloc(32, 1), relayTopic: 'room' };
  const room = new RoomManager({
    transports: [transport], now: Date.now, randomBytes: (n) => new Uint8Array(n).fill(0xab),
    deriveKeys: async () => keys, appVersion: '0.5.2', profile: () => ({ name: 'Me', color: 1, rgb: null, limit: 5, nf: [] }),
    announceEmotes: () => [],
    resolveTarget: () => ({ displayId: 1, width: 1920, height: 1080 }),
  });
  let pings = 0, wants = 0, ballots = 0;
  room.on('remotePing', () => pings++);
  room.on('want', () => wants++);
  room.on('ballot', () => ballots++);
  const code = makeRoomCode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  try {
    for (let n = 1; n <= 1000; n++) {
      const joined = await room.join(code);
      if (!joined.ok) throw new Error('room failed to join');
      const seed = Buffer.alloc(32);
      seed.writeUInt32LE(n);
      const identity = makeIdentity(seed);
      const base = { peer: peerIdOf(identity.pk), ts: Date.now() };
      for (const message of [
        { ...base, seq: 1, t: 'presence', proto: 1, app: '0.5.2', name: 'Peer', color: 2, status: 'on', pk: identity.pk.toString('base64'), em: [], nf: [] },
        { ...base, seq: 2, t: 'ping', ping: 'danger', d: 1, x: 0.5, y: 0.5 },
        { ...base, seq: 3, t: 'want', to: room.self, h: 'a'.repeat(32), need: [] },
        { ...base, seq: 4, t: 'ballot', id: '0a1b2c3d', yes: true },
      ] satisfies RoomMessage[]) {
        const body = encodeMessage(message);
        const signed = joinSigned(new TextDecoder().decode(body), signBody(identity, body));
        transport.emit('packet', 'lan:127.0.0.1:47474', seal(keys.msgKey, new TextEncoder().encode(signed)));
      }
      room.leave();
    }
    if (pings !== 1000 || wants !== 1000 || ballots !== 1000 || room.state().phase !== 'idle') {
      throw new Error(`room lifecycle delivered ${pings} pings, ${wants} wants and ${ballots} ballots`);
    }
    for (const name of ['limiter', 'transferLimiter', 'ballotLimiter']) {
      const limiter: unknown = Reflect.get(room, name);
      if (!(limiter instanceof RateLimiter) || limiter.size !== 0) throw new Error(`${name} retained buckets after leaving`);
    }
    console.log(JSON.stringify({ scenario: 'join-ping-leave', cycles: 1000, pings, wants, ballots, retainedIncomingBuckets: 0 }));
  } finally {
    room.quit();
  }
}

async function run(): Promise<void> {
  if (!existsSync(helper)) throw new Error('run npm run build:helper before the lifecycle scenario');
  const temporary = await mkdtemp(join(tmpdir(), 'lolping-lifecycle-'));
  try {
    await settingsLifecycle(temporary);
    await restartConfig();
    await toggleDuringSettingsChange(join(temporary, 'interleaved'));
    await tailOutput();
    await roomLifecycle();
  } finally {
    await Promise.all(bridges.map((bridge) => bridge.stop()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

void run().catch((error: unknown) => { console.error('FAIL:', error); process.exitCode = 1; });
