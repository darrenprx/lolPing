# Internet Rooms (v0.4.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Room members on different networks share pings through free public Nostr relays, alongside the v0.3.0 LAN path.

**Architecture:**
- A `RelayTransport` (kind `internet`, a shared medium) joins `LanTransport` under `RoomManager`.
- It wraps a `RelayPool` of `RelayConnection`s: Node's built-in `WebSocket`, one per pinned relay.
- Packets travel as NIP-01 ephemeral events, kind 24747, signed with a key made on each join, carrying the existing sealed packet as base64.
- RoomManager gains:
  - one send per shared transport;
  - relay send caps;
  - presence when a relay connects (`linkUp`);
  - a settle window that waits for the relays;
  - a live "Allow internet connections" switch.

**Tech Stack:** Electron 44 main process (Node 24), TypeScript 5.9, `@noble/secp256k1` 3.2.0, vitest 5 with fake timers, `ws` 8.22.0 (test relay only), esbuild (tools), React 19 + Fluent UI 9.

**Spec:** `docs/superpowers/specs/2026-10-05-internet-rooms-design.md`, which builds on `docs/superpowers/specs/2026-10-04-room-ping-sharing-design.md`.

## Global Constraints

- **Branch and commits:**
  - Work on branch `rooms-internet`, cut from `main`.
  - **No commits until the end.** The whole release (spec, plan, checklist, code, docs) lands as **one commit**, after the user's go-ahead. Tasks end with a checkpoint, not a commit.
  - No Claude or AI attribution in commits, PRs or repo files: no `Co-Authored-By`, no "Generated with".
- **Dependencies:** every npm package is a devDependency at an exact version, because electron-vite bundles everything and the installer ships only `out/**`. New: `@noble/secp256k1` 3.2.0, `ws` 8.22.0, `@types/ws` 8.18.2.
- **Protocol:** `PROTOCOL_VERSION` stays 1. The AES-GCM envelope, message types and `roomCrypto` known-answer vectors don't change.
- **Strings:** every new user-facing string exists in en and zh-CN in `src/shared/i18n.ts`.
- **Constants** are exactly those in spec §3.3 and §4.7:
  - event kind 24747;
  - relay health 25 s; `unavailable` after 15 s;
  - backoff 2 s → 60 s, ×2, ±20%; rate-limit cool-down 30 s;
  - incoming budget 200 events/s; dedupe memory 512 ids; per-relay raw limits 64 KB per message and 400 messages/s;
  - ping cap 5/s with bursts of 10; change-driven presence at most once a second; bye drain ≤ 500 ms;
  - internet presence every 10 s, alive 25 s, member drop after 30 s;
  - settle 3 s after the relays leave `starting`, capped at 15 s.
- **Dev runs:**
  - Back up `%APPDATA%\lolPing\settings.json` first and restore it afterwards.
  - Check the running app over CDP (DevTools remote debugging), never desktop computer-use.
  - Use no firewall or other system-setting changes; `LOLPING_RELAYS` stands in for "relays blocked".
- **Style:** match the surrounding code: comment density, naming, and the EventEmitter plus `status` pattern of `src/main/lanTransport.ts`.

## Review Focus

1. **Silent network switch** (Wi-Fi → hotspot, no sleep): sockets look open but are dead. Expected: the internet path is back within about 30 s. → Task 2 test `a silent socket is closed and reconnected after 25 s without an echo`.
2. **Quitting while relays are still connecting or unreachable:** quit must not hang. Expected: `whenClosed()` resolves at once when nothing is pending, and within 500 ms otherwise. → Task 4 test `stop while connecting resolves whenClosed at once`.
3. **Flipping "Allow internet connections" quickly, or pressing Retry repeatedly during backoff:** no duplicate sockets per relay and no leaked pools. → Task 3 test `retryNow during backoff keeps one socket per relay`; Task 5 test `toggling internet off/on/off leaves one stopped relay transport`.
4. **Leave and rejoin, or switching rooms, while old relay sockets are still closing:** nothing from the old session reaches the new one. → Task 4 test `packets from a stopped session are never emitted`.
5. **Every relay unreachable at join:** the join must not hang in `joining`. Expected: `active` after the 15 s cap, with internet `unavailable`. → Task 5 test `settles at the 15 s cap when the internet never leaves starting`.

---

### Task 1: Nostr events, the relay probe and the go/no-go gate

**Files:**
- Create: `src/main/nostrEvent.ts`, `tests/main/nostrEvent.test.ts`
- Create: `tools/relay-probe/run.mjs`, `tools/relay-probe/probe.ts`, `tools/relay-probe/README.md`
- Create: `src/main/relays.ts`
- Modify: `package.json` (devDependency `@noble/secp256k1` 3.2.0); `tsconfig.json` (`include` gains `tools/relay-probe`, next to `tools/room-peer`)

**Interfaces:**
- Produces, in `src/main/nostrEvent.ts`:
```ts
export const ROOM_EVENT_KIND = 24747;
export interface NostrEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }
export interface KeyPair { secretKey: Uint8Array; pubkey: string } // pubkey: 64 hex chars, x-only
export function makeKeyPair(): KeyPair;
/** NIP-01 canonical form: [0,pubkey,created_at,kind,tags,content], no spaces. */
export function serializeEvent(pubkey: string, createdAt: number, kind: number, tags: string[][], content: string): string;
export function signEvent(keys: KeyPair, kind: number, tags: string[][], content: string, createdAt: number): NostrEvent;
export type RelayMessage =
  | { type: 'EVENT'; subId: string; event: NostrEvent }
  | { type: 'OK'; eventId: string; ok: boolean; message: string }
  | { type: 'EOSE'; subId: string }
  | { type: 'CLOSED'; subId: string; message: string }
  | { type: 'NOTICE'; message: string };
export function parseRelayMessage(text: string): RelayMessage | null;
export function reqMessage(subId: string, topic: string, since: number): string; // ["REQ",subId,{"kinds":[24747],"#x":[topic],"since":since,"limit":0}]
export function eventMessage(e: NostrEvent): string;                             // ["EVENT",e]
export function closeMessage(subId: string): string;                             // ["CLOSE",subId]
```
- Produces, in `src/main/relays.ts`: `export const RELAYS: readonly string[]`. Its contents come from the probe.

- [ ] **Step 1: Write the failing tests** in `tests/main/nostrEvent.test.ts`:
  - `serializes per NIP-01`:
    - `serializeEvent('a'.repeat(64), 1700000000, 24747, [['x', 'ab']], 'hi')` equals `` `[0,"${'a'.repeat(64)}",1700000000,24747,[["x","ab"]],"hi"]` ``.
    - `signEvent(...).id` equals the SHA-256 hex of the serialised string, computed in the test with `node:crypto`.
  - `matches BIP-340 test vector 0`: after importing `nostrEvent.ts` (which installs `hashes.sha256`), `schnorr.getPublicKey(sk3)` is `f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9`, and `schnorr.sign(zero32, sk3, zero32)` is `e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0`. Here `sk3` is 31 zero bytes then `0x03`, and `zero32` is 32 zero bytes.
  - `signs events that verify`:
    - `schnorr.verify(hex(sig), hex(id), pubkey)` is true.
    - `makeKeyPair().pubkey` matches `/^[0-9a-f]{64}$/`.
    - Two key pairs differ.
  - `parses each relay message type`: a table of one valid string per type → the expected object.
  - `rejects junk` (each → `null`):
    - not JSON; not an array; an unknown type;
    - `EVENT` with: an id that isn't 64 hex chars; a sig that isn't 128 hex chars; `created_at: 1.5`; a tag containing a number; numeric content;
    - `OK` with a non-boolean flag.
  - `ignores prototype-pollution keys`: an `EVENT` whose event carries `"__proto__":{"polluted":1}` parses, and afterwards `({} as any).polluted` is `undefined`.
- [ ] **Step 2: Run the tests and see them fail.** `npx vitest run tests/main/nostrEvent.test.ts` → FAIL (cannot find module).
- [ ] **Step 3: Implement.**
  - `npm i -D -E @noble/secp256k1@3.2.0`.
  - In `nostrEvent.ts`, install `hashes.sha256` from `node:crypto` `createHash` at module load, so the synchronous `schnorr.sign` works.
  - `signEvent` signs the id bytes with `schnorr.sign(id, secretKey)`, using noble's default random aux.
  - `makeKeyPair` uses `schnorr.keygen()`.
  - `parseRelayMessage` builds fresh objects from known fields only. It never spreads parsed input.
- [ ] **Step 4: Run the tests and see them pass.** `npx vitest run tests/main/nostrEvent.test.ts` → PASS.
- [ ] **Step 5: Write the probe** in `tools/relay-probe/`.
  - **`run.mjs`:** the same esbuild runner as `tools/room-peer/run.mjs`, building `probe.ts` to `<tmpdir>/lolping-relay-probe.mjs`.
  - **Candidates:**
    - `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`, `wss://offchain.pub`, `wss://relay.nostr.net`, `wss://nostr.oxtr.dev`, `wss://relay.snort.social`;
    - `wss://nostr-pub.wellorder.net`, `wss://nostr.bitcoiner.social`, `wss://relay.nostr.bg`, `wss://relay.agentry.com`, `wss://relay.layer.systems`, `wss://nostr.stakey.net`, `wss://relay.routstr.com`, `wss://nostr.rblb.it`.
  - **Options:** `--relays a,b` overrides the candidates; `--burst-rate` (default 5); `--soak-min` (default 10, 0 skips the soak).
  - **Each relay runs in parallel**, with its own `makeKeyPair()`, a random 64-hex topic, and random base64 content of 1600 characters, the size of a real packet.
  - **Phases per relay:**
    1. Connect, then send `reqMessage` (time it).
    2. 20 round trips, 500 ms apart: record `OK` and echo latency.
    3. A 30 s burst at `--burst-rate` per second: count `rate-limited:` replies and the share of events echoed.
    4. A soak at one event per 10 s: count closes, and reconnect and resubscribe after each.
  - **Verdict per relay** uses the spec §6.2 table.
  - **Output:** a table of URL, connect ms, accepted, median, p95, burst echo %, rate-limited count, soak closes, and PASS or FAIL with the reason. The JSON report goes to `<os.tmpdir()>/lolping-relay-probe.json`.
  - **`README.md`:** what the probe does, that it sends about 250 ephemeral events per relay and shows the relays this machine's IP address, and how to use it.
- [ ] **Step 6: Run the probe** (the user approved it): `node tools/relay-probe/run.mjs`. It takes about 11 minutes.
- [ ] **Step 7: Apply the gate** (spec §6.2).
  - **4 or more PASS:** go. Write up to 6 to `src/main/relays.ts`, preferring different operators. Add a comment with the probe date and the compatibility rule: any later version keeps at least 3 relays from the previous list.
  - **Fewer than 4 pass the burst at 5/s:** rerun with `--burst-rate 2 --soak-min 0` on the relays that failed only the burst. If 4 or more then pass: go, and Task 5 uses a 2/s cap with bursts of 4.
  - **Fewer than 3 pass at all:** **stop.** Report to the user, and do no further tasks.
- [ ] **Step 8: Checkpoint.** `npm run typecheck` → no errors. Do not commit.

### Task 2: RelayConnection

**Files:**
- Create: `src/main/relayConnection.ts`, `tests/main/relayConnection.test.ts`, `tests/main/fixtures/fakeSocket.ts`

**Interfaces:**
- Consumes: from Task 1, `NostrEvent`, `ROOM_EVENT_KIND`, `parseRelayMessage`, `reqMessage`.
- Produces:
```ts
export type RelayState = 'connecting' | 'live' | 'cooling' | 'down' | 'retired';
/** The slice of the WebSocket API in use; Node's global WebSocket satisfies it. */
export interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;
export interface RelayConnectionOptions { url: string; topic: string; pubkey: string; socket?: SocketFactory; random?: () => number }
/** Events: 'event' (NostrEvent from someone else), 'echo', 'live', 'ok' (eventId, ok, message), 'state' (RelayState). */
export class RelayConnection extends EventEmitter {
  readonly url: string;
  state: RelayState;
  get healthy(): boolean;               // live or cooling, and echoed within the last 25 s
  start(): void;
  stop(): void;                         // for good: no reconnect, no events afterwards
  publish(json: string): void;          // sent only while 'live'
  reconnectNow(revive: boolean): void;  // skip any backoff; `revive` also un-retires
}
```
- `tests/main/fixtures/fakeSocket.ts` exports `FakeSocket` (fields `url`, `sent: string[]`, `closed`; methods `open()`, `receive(msg: unknown[] | string)`, `drop()` which fires `onclose`) and `fakeSockets(): { factory: SocketFactory; sockets: FakeSocket[] }`.

**Values:**
- Subscription id `'lolping'`; `since` = `floor(now / 1000) − 600`.
- Connect deadline 10 s.
- Health 25 s, counted from going live or from the last echo.
- Backoff 2 s → 60 s, ×2, jitter `1 + (random() * 2 − 1) * 0.2`; reset after 60 s healthy.
- Cool-down 30 s.
- Raw limits: 64 KB per message, 400 messages per second.
- Retiring `OK` prefixes: `blocked:`, `restricted:`, `auth-required:`, `pow:`, `invalid:`.

- [ ] **Step 1: Write the failing tests.** Use `vi.useFakeTimers()`, `random = () => 0.5` (no jitter) and a fake socket.
  - `opens, subscribes and goes live`: the first message sent is exactly `["REQ","lolping",{"kinds":[24747],"#x":[topic],"since":<now s − 600>,"limit":0}]`, and `'live'` is emitted.
  - `publishes only while live`.
  - `separates echoes from other members' events, and ignores other subscriptions, kinds and topics`.
  - `is healthy after the first echo, and down after 25 s without one`, then a new socket appears after exactly 2000 ms.
  - `a silent socket is closed and reconnected after 25 s without an echo`: no `onclose` fires; assert `closed` is true, then a new socket.
  - `backs off 2, 4, 8 … up to 60 s, and resets after 60 s healthy`.
  - `counts a socket that hasn't opened within 10 s as down`.
  - `rate-limited: cools for 30 s, publishes nothing, and isn't marked down for missing echoes`.
  - `retires on blocked:, restricted:, auth-required:, pow: and invalid:`, and nothing reconnects until `reconnectNow(true)`.
  - `resubscribes after one CLOSED and retires after a second`.
  - `retires after a message over 64 KB or more than 400 messages in one second`.
  - `reconnectNow(false) skips the backoff but leaves a retired relay alone`.
  - `stop() closes the socket and emits nothing afterwards`.
- [ ] **Step 2:** `npx vitest run tests/main/relayConnection.test.ts` → FAIL.
- [ ] **Step 3: Implement `RelayConnection`.** It uses `opts.socket ?? ((url) => new WebSocket(url))`. Every timer is cleared on `stop()`, and handlers from a replaced socket are ignored by checking identity, as `lanTransport.ts` does with `this.sock !== sock`.
- [ ] **Step 4:** `npx vitest run tests/main/relayConnection.test.ts` → PASS.
- [ ] **Step 5: Checkpoint.** `npm run typecheck` → no errors.

### Task 3: RelayPool

**Files:**
- Create: `src/main/relayPool.ts`, `tests/main/relayPool.test.ts`

**Interfaces:**
- Consumes: from Task 2, `RelayConnection`, `SocketFactory` and `fakeSockets`; from Task 1, `NostrEvent` and `eventMessage`; `TransportStatus` from `src/main/transport.ts`.
- Produces:
```ts
export interface RelayPoolOptions { urls: readonly string[]; topic: string; pubkey: string; socket?: SocketFactory; random?: () => number }
/** Events: 'event' (NostrEvent, deduplicated and within budget), 'status' (TransportStatus), 'linkUp' (url), 'ok' (eventId, ok). */
export class RelayPool extends EventEmitter {
  status: TransportStatus;   // 'off' until start()
  start(): void;
  stop(): void;
  publish(e: NostrEvent): void;  // serialised once, sent to every live relay
  retryNow(): void;              // every relay reconnects now, retired ones included
  wake(): void;                  // every relay that isn't retired reconnects now
}
```

**Values:** `unavailable` after 15 s; dedupe over the last 512 ids; 200 events/s, counted after dedupe.

- [ ] **Step 1: Write the failing tests:**
  - `publishes to live relays only, including a fresh one before its first echo`.
  - `goes starting → ok on the first echo → unavailable when no relay is healthy → ok again`.
  - `is unavailable after 15 s without any echo`.
  - `passes an event that arrives from several relays once`, and `forgets ids after 512 newer ones`.
  - `caps incoming events at 200 per second across relays`.
  - `emits linkUp each time a relay goes live`.
  - `retryNow during backoff keeps one socket per relay`: call it three times quickly; each URL has exactly one open socket.
  - `retryNow revives retired relays; wake does not`.
  - `stop closes every socket and emits nothing afterwards`.
- [ ] **Step 2:** `npx vitest run tests/main/relayPool.test.ts` → FAIL.
- [ ] **Step 3: Implement `RelayPool`.** Dedupe uses a `Set` plus a ring of 512 ids. The budget is a per-second window counter.
- [ ] **Step 4:** `npx vitest run tests/main/relayPool.test.ts` → PASS.
- [ ] **Step 5: Checkpoint.** `npm run typecheck`.

### Task 4: Keys, the Transport interface and RelayTransport

**Files:**
- Modify: `src/main/roomCrypto.ts` and `tests/main/roomCrypto.test.ts`.
- Modify: `src/main/transport.ts`, `src/main/lanTransport.ts`, `tests/main/fixtures/fakeTransport.ts`, and the `KEYS` constant in `tests/main/roomManager.test.ts`.
- Create: `src/main/relayTransport.ts`, `tests/main/relayTransport.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–3 and `RELAYS`.
- Produces:
```ts
// roomCrypto.ts — sig-pw removed; relayTopic still from HKDF info "sig-room"
export interface RoomKeys { msgKey: Buffer; relayTopic: string }
// transport.ts — added to Transport; event docs gain 'linkUp' (a new link came up: send presence now)
readonly shared: boolean;
whenClosed(): Promise<void>;
// relayTransport.ts
export interface RelayTransportOptions { urls?: readonly string[]; socket?: SocketFactory; random?: () => number } // urls default: RELAYS
/** Events: 'packet' (`net:<pubkey>`, Buffer), 'status' (TransportStatus), 'linkUp'. */
export class RelayTransport extends EventEmitter implements Transport {
  readonly kind = 'internet';
  readonly shared = true;
  status: TransportStatus;
  start(keys: RoomKeys): void;   // fresh makeKeyPair(), new RelayPool with topic = keys.relayTopic
  stop(): void;                  // status 'off' at once; pool closed after the last published event's OK, or 500 ms
  whenClosed(): Promise<void>;
  sendTo(peer: PeerKey, packet: Uint8Array): void;  // same as broadcast
  broadcast(packet: Uint8Array): void;              // kind 24747, tags [["x", topic]], base64 content, created_at = now in s
  retryNow(): void;
  wake(): void;
}
```
- `LanTransport` gains `readonly shared = false`.
- `FakeTransport`:
  - constructor `(kind = 'lan', shared = kind === 'internet')`;
  - `whenClosed()` resolves at once;
  - counters `starts` and `stops`;
  - helper `linkUp()` emits `'linkUp'`.

- [ ] **Step 1: Write the failing tests.**
  - `roomCrypto`: in `matches the known-answer vectors`, `k.relayTopic` is `'0381782f350540d4639958bed594ae3b2b1a3d11683146e542edb34db89b6910'`, and the `sigPassword` line is gone.
  - `relayTransport`, with fake sockets:
    - `wraps a packet as a kind 24747 event with our topic, base64 content and a valid signature`.
    - `emits packet(net:<pubkey>, bytes) for other members' events`.
    - `drops content over 1600 characters or that isn't base64`.
    - `uses a new key pair on every start`.
    - `stop waits for the bye's OK, at most 500 ms`: an `OK` at 100 ms resolves at 100 ms; no `OK` resolves at 500 ms.
    - `stop while connecting resolves whenClosed at once`.
    - `packets from a stopped session are never emitted`: start, stop, start again; an event delivered on an old socket produces no `'packet'`.
    - `forwards status and linkUp from the pool`.
- [ ] **Step 2:** `npx vitest run tests/main/roomCrypto.test.ts tests/main/relayTransport.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - The `RoomKeys` change, then rename `sigRoomId` → `relayTopic` everywhere `tsc` complains.
  - `transport.ts`, `LanTransport.shared` and the `FakeTransport` changes.
  - `RelayTransport`.
- [ ] **Step 4:** `npm test` → every suite passes, including the existing room tests.
- [ ] **Step 5: Checkpoint.** `npm run typecheck`.

### Task 5: RoomManager over a shared transport

**Files:**
- Modify: `src/main/rateLimiter.ts`, `tests/main/rateLimiter.test.ts`, `src/main/roomManager.ts`, `tests/main/roomManager.test.ts`

**Interfaces:**
- Consumes: from Task 4, `Transport.shared`, `whenClosed` and the `'linkUp'` event.
- Produces:
  - `RateLimiter.allow(key: string, perSecond: number, burst = perSecond): boolean`.
  - `RoomManager.setInternetAllowed(on: boolean): void`.
  - Constants in `roomManager.ts`:
    - `RELAY_PING_RATE = 5` and `RELAY_PING_BURST = 10` (2 and 4 if Task 1's gate said so);
    - `SHARED_PRESENCE_MS = 1000`, `SETTLE_CAP_MS = 15_000`;
    - `ALIVE_MS.internet = 25_000`, and member drop 15 s, or 30 s for a member ever heard over internet (`Member.viaInternet: boolean`).

**Behaviour:** spec §3.3. In short:
- On a shared transport, a ping is sent once, under the cap. LAN members still get every ping per member.
- `linkUp`, a new member's presence and profile or status changes request presence on a shared transport. The first goes out at once; the rest within that second merge into one at its end, carrying the latest state.
- Settle runs 3 s after the internet transport leaves `starting`, or after 3 s if it isn't running, and never later than 15 s.
- `setInternetAllowed(false)` while in a room: stop the internet transport **without bye** and delete every member's `paths.internet`.
- `setInternetAllowed(true)`: start it with the current keys, then request presence.
- `state().internet` is `'off'` while not allowed.

- [ ] **Step 1: Write the failing tests.** Use `lan = new FakeTransport('lan')` and `net = new FakeTransport('internet')`.
  - `rateLimiter`: `allows a burst bigger than the rate when asked`. `allow('a', 5, 10)` gives 10 × `true`, then `false`; after 200 ms, one more `true`.
  - `sends a ping once over a shared transport, however many members use it`.
  - `caps pings over a shared transport at 5/s with bursts of 10, while LAN members still get every ping`.
  - `never caps presence or bye over a shared transport`.
  - `answers linkUp and new members with presence at once, then at most once a second, the latest state winning`.
  - `joining over relays only announces as soon as the first relay is live, not at the 10 s round`.
  - `settles 3 s after the internet transport leaves starting`.
  - `settles at the 15 s cap when the internet never leaves starting`.
  - `settles after 3 s when internet is not allowed`.
  - `keeps an internet path alive for 25 s and drops an internet member after 30 s`, while a LAN-only member is still dropped at 15 s.
  - `setInternetAllowed(false) mid-room stops the relay transport without a bye and forgets internet paths`.
  - `setInternetAllowed(true) mid-room starts it with the current keys and announces`.
  - `toggling internet off/on/off leaves one stopped relay transport`: `net.starts - net.stops === 0`, `net.started === null`, and `state().internet === 'off'`.
  - Re-check the existing `two transports` tests under the new semantics. "Unicasts presence only on LAN" still holds.
- [ ] **Step 2:** `npx vitest run tests/main/rateLimiter.test.ts tests/main/roomManager.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `rateLimiter.ts` and `roomManager.ts`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Checkpoint.** `npm run typecheck`.

### Task 6: Integration test over a fake relay

**Files:**
- Create: `tests/main/fixtures/fakeRelay.ts`, `tests/main/relayRoom.test.ts`
- Modify: `package.json` (`npm i -D -E ws@8.22.0 @types/ws@8.18.2`)

**Interfaces:**
- Consumes: `RelayTransport` (Task 4), `RoomManager` (Task 5), `LanTransport`, `deriveRoomKeys`.
- Produces: `startFakeRelay(): Promise<{ url: string; close(): Promise<void> }>`.
  - A `ws` `WebSocketServer` on `127.0.0.1`, port 0.
  - `REQ` records the filter's `kinds` and `#x`.
  - `EVENT` replies `["OK",id,true,""]` and forwards the event to every matching subscription, the author's included.
  - `CLOSE` removes the subscription. `since` and `limit` are ignored.

- [ ] **Step 1: Write the tests** with real timers and an `until()` helper copied from `lanRoom.test.ts`. Both rooms use `new RelayTransport({ urls: [relay.url] })`.
  - `two rooms meet over a relay, exchange a ping, and see bye`: each sees the other with path `'internet'`; a `remotePing` arrives with the sender's tag; `leave()` gives the other a `'left'` toast.
  - `switches a member to the internet path when LAN stops`:
    - Each side also has a loopback `LanTransport` on ports 47511 and 47512 with seeds, as `lanRoom.test.ts` does.
    - Both start on `'lan'`.
    - After `lanB.stop()`, A shows B on `'internet'` within 8 s.
    - Test timeout 20 s.
- [ ] **Step 2:** `npx vitest run tests/main/relayRoom.test.ts` → PASS. Every earlier task's units are in place, so a failure here is an integration bug: fix it in the owning module.
- [ ] **Step 3: Checkpoint.** `npm test` → all pass.

### Task 7: Wiring and IPC

**Files:**
- Modify: `src/main/index.ts`, `src/main/settingsIpc.ts`, `src/shared/settingsChannels.ts`, `src/preload/settings.ts`, `src/shared/ipc.ts`

**Interfaces:**
- Produces:
  - `SETTINGS_CH.roomRetryInternet = 'room:retryInternet'`.
  - `SettingsApi.retryInternet(): Promise<void>`.
  - In the `registerSettingsIpc` deps, `room.retryInternet(): void`.

- [ ] **Step 1: Wire `index.ts`.**
  - Create `relay = new RelayTransport({ urls: relayUrls() })`. `relayUrls()` returns `process.env.LOLPING_RELAYS` split on commas, keeping `wss://` entries, when `!app.isPackaged` and the variable is set. Otherwise it returns `RELAYS`.
  - `transports: [lan, relay]`.
  - Call `room.setInternetAllowed(settings.allowInternet)` before the rejoin-on-launch line.
  - In `store.on('change')`: when `allowInternet` changed, call `room.setInternetAllowed(s.allowInternet)`, then `pushRoom()`.
  - On `powerMonitor` resume: `lan.rebind(); relay.wake();`.
  - IPC `retryInternet: () => relay.retryNow()`.
  - On quit, `Promise.allSettled` also waits for `relay.whenClosed()`.
- [ ] **Step 2: Add the IPC channel, handler, preload method and type.** The handler takes no arguments.
- [ ] **Step 3: Verify.** `npm run typecheck && npm test && npm run build` → all succeed.
- [ ] **Step 4: Smoke test** (settings backed up). Start `npm run dev` with remote debugging and join a room. Over CDP, call `api.getRoom()` in the settings window: `internet` is `'ok'` within 5 s using the pinned relays. Restore settings. Checkpoint.

### Task 8: Room page

**Files:**
- Modify: `src/shared/i18n.ts`, `src/renderer/settings/components/RoomSection.tsx`, `src/renderer/settings/settings.css`, `tests/shared/i18n.test.ts`

**Interfaces:**
- Consumes: `api.retryInternet()` (Task 7); `RoomState.internet`; `Settings.allowInternet`.
- Produces:
  - New string keys: `roomInternet`, `roomInternetDesc`, `roomInternetUnavailable`, `roomInternetUnavailableDesc`, `roomRetry`, `roomLonelyInternetOff`.
  - Replaced: `roomPrivacy`, `roomHelp`.
  - Text is verbatim from spec §8.2, en and zh-CN.

- [ ] **Step 1: Write the failing test** in `i18n.test.ts`: `room privacy text describes relays, not direct connections`. For both languages, `roomPrivacy` contains `relays` (en) or `中继` (zh-CN), and en no longer contains `directly`.
- [ ] **Step 2:** `npx vitest run tests/shared/i18n.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - Add the strings, in both languages.
  - `RoomSection`:
    - A `SwitchRow` with `Globe24Regular`, bound to `allowInternet`, placed directly above "Rejoin last room on launch".
    - `InRoom` gets an `allowInternet` prop.
    - When `room.internet === 'unavailable'`, show a `card permission` with `roomInternetUnavailable`, `roomInternetUnavailableDesc` and a `Button` (`roomRetry`) that calls `api.retryInternet()`.
    - When alone, the lonely line appends `roomLonelyInternetOff` if `!allowInternet`.
  - `settings.css`: `.badge.internet` gets its own colour: `color: #3a96dd; border-color: rgba(58, 150, 221, .5)`. LAN keeps the green.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run build` → PASS.
- [ ] **Step 5: Look at it.** In a dev run, check over CDP:
  - the switch;
  - the unavailable card, with `LOLPING_RELAYS=wss://127.0.0.1:9` so no relay is reachable;
  - Retry;
  - the lonely hint with the switch off.

  Compare against `prototype/room-demo.html`. Restore settings. Checkpoint.

### Task 9: `room-peer --relay`

**Files:**
- Modify: `tools/room-peer/peer.ts`, `tools/room-peer/README.md`

- [ ] **Step 1: Add the `--relay` flag.**
  - It uses `new RelayTransport()` (the pinned `RELAYS`) instead of `LanTransport`.
  - Presence every 10 s and on `'linkUp'`.
  - In relay mode, `--rate` is clamped to 5 and a note is printed.
  - It prints `[relay] <status>`.
  - On Ctrl+C: bye, `stop()`, then exit once `whenClosed()` resolves.
  - The README gains a `--relay` section.
- [ ] **Step 2: Verify.** Run two peers in one room, `--relay --name A --rate 0` and `--relay --name B --rate 1`. Each prints the other's presence; A prints B's pings within about a second each. Checkpoint.

### Task 10: Docs and version

**Files:**
- Modify: `README.md`, `README.zh-CN.md`, `docs/design.md` §12, `docs/superpowers/specs/2026-10-04-room-ping-sharing-design.md` §5.5, `package.json` and `package-lock.json`

- [ ] **Step 1: README and README.zh-CN, Rooms section.**
  - Rooms work across networks through public relays when "Allow internet connections" is on.
  - What relays see and never see: spec §7 wording.
  - The Tailscale note now says Tailscale users simply connect over the internet path.
  - The tools table gains `relay-probe`.
- [ ] **Step 2: `docs/design.md` §12** gets a "Relay transport" subsection: the modules, the event shape, health and status in brief. In the v0.3.0 spec's §5.5, add one line at the top: "Replaced by `2026-10-05-internet-rooms-design.md` (relays instead of WebRTC)."
- [ ] **Step 3: Version.** `npm version 0.4.0 --no-git-tag-version`.
- [ ] **Step 4:** `npm run build:site` → succeeds. Checkpoint.

### Task 11: Review, verification, checklist and the single commit

**Files:**
- Create: `docs/superpowers/plans/2026-10-05-internet-rooms-v0.4.0-checklist.md`

- [ ] **Step 1: Full checks.** `npm run typecheck && npm test && npm run test:helper && npm run build && npm run build:site && npm run dist` → all succeed. Record the test counts.
- [ ] **Step 2: Independent review.** A fresh reviewer compares the whole diff with the spec and the Review Focus. Fix every finding, minor ones included, then rerun Step 1.
- [ ] **Step 3: Verification by a Sonnet subagent** of every item that can be checked on one PC. Settings are backed up first and restored afterwards; the dev app is driven over CDP.
  - **Relays:** with `room-peer --relay` in the same room, the member appears with `Internet` within 5 s, and pings go both ways.
  - **Switch:**
    - Turning "Allow internet connections" off gives `internet: 'off'` and closes the relay sockets.
    - The peer sees a `disconnected` after about 30 s, not `left`.
    - Turning it back on brings the member back.
  - **No relays:** `LOLPING_RELAYS=wss://127.0.0.1:9` shows the unavailable card. Retry reconnects at once.
  - **Quit:** the app exits within 1 s while in a room.
  - **Cleanup:** settings restored, processes stopped.
- [ ] **Step 4: Write the checklist file.**
  - What was verified, with results.
  - The spec §10 manual items left for real devices: two networks with a hotspot, Windows ↔ Mac, sleep and wake, mid-room toggling, the spam cap, and blocking relays with the firewall (optional).
- [ ] **Step 5: Hand over** the checklist to the user. After their go-ahead, make **one commit** of everything: spec, plan, checklist, code, docs and prototype. The message has no AI attribution. Merge and tag only when asked.
