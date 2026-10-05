# Internet rooms — Design Spec

**Date:** 2026-10-05
**Status:** Approved in brainstorming; not yet implemented
**Target:** v0.4.0
**Builds on:** [2026-10-04-room-ping-sharing-design.md](2026-10-04-room-ping-sharing-design.md) (rooms, codes, keys, envelope, messages, LAN). This spec replaces that spec's §5.5 and its M2 delivery list. Everything not mentioned here stays as specified there and as shipped in v0.3.0.

## 1. Purpose

Let room members on **different networks** see each other's pings, without any server run or paid for by the project.

**Success criteria:**
1. A friend on another network types the room code and appears with an `Internet` badge within a few seconds.
2. Pings over the internet arrive in well under a second.
3. Nobody outside the room can read, inject or replay pings. Public relays learn nothing beyond what §7 lists.
4. Losing every relay, or any single relay, never breaks the LAN path or the app.
5. Windows ↔ Windows, Windows ↔ macOS and macOS ↔ macOS all work.

## 2. Decisions log

| Topic | Decision |
|---|---|
| Internet path | **Relays only.** Every internet packet goes through free public **Nostr relays** as an ephemeral event. No WebRTC, no hidden window, no Trystero. |
| Why not direct WebRTC | Without TURN, many pairs can't connect directly anyway, so a relay path had to exist. With it built, direct WebRTC is an optional later upgrade (§12), not a requirement. |
| Where it runs | Main process. Node's built-in `WebSocket` (Electron 44 = Node 24) plus `@noble/secp256k1` for Nostr signatures. |
| Hybrid | Unchanged: every room runs LAN and internet at once; per member, LAN wins while it is alive. |
| Relay list | Pinned in the app (`src/main/relays.ts`), chosen by a probe run before building (§6). |
| Relay etiquette | Outgoing pings over relays are capped at 5/s per sender, bursts up to 10. Presence and bye are never capped. |
| Privacy gain | Members no longer see each other's IP over the internet path; only relays see your IP. |
| Allow internet connections | Existing setting (default on), now with UI. Off: relays are never contacted. |
| Protocol | Unchanged: `PROTOCOL_VERSION` 1, same envelope and messages. v0.3.0 and v0.4.0 meet over LAN. |

## 3. Architecture

```
main process
 └─ RoomManager ───────── unchanged role; small changes in §3.3
      ├─ LanTransport          (v0.3.0, unchanged)
      └─ RelayTransport        kind 'internet', shared medium
           └─ RelayPool        one RelayConnection per pinned relay
                └─ nostrEvent  build and sign events, parse relay messages
```

### 3.1 New modules

| Module | Kind | Responsibility |
|---|---|---|
| `src/main/nostrEvent.ts` | pure + noble | NIP-01 event id (SHA-256 of the canonical array), BIP-340 Schnorr signing, `makeKeyPair()`, and `parseRelayMessage(text) → RelayMessage \| null` for `EVENT`, `OK`, `NOTICE`, `CLOSED`, `EOSE`. |
| `src/main/relayConnection.ts` | WebSocket | One socket to one relay: connect, subscribe, resubscribe after reconnect, publish, health, backoff, `OK false` handling. WebSocket constructor and clock are injected for tests. |
| `src/main/relayPool.ts` | logic | Owns the connections. Publishes to every live relay, merges incoming events (echo credit, id dedupe, incoming budget), derives the pool status, `retryNow()`. |
| `src/main/relayTransport.ts` | Transport | Implements `Transport` (kind `internet`, `shared: true`) on top of the pool: packet ⇄ base64 event content; a fresh Nostr key pair on every `start`; drains a final bye on `stop`. |
| `src/main/relays.ts` | data | The pinned relay list and its compatibility rule (§6.3). |
| `tools/relay-probe/` | tool | The go/no-go probe (§6). |

### 3.2 Transport interface change

```ts
interface Transport extends EventEmitter {
  readonly kind: 'lan' | 'internet';
  /** One send reaches every member (relays). RoomManager then sends each packet once, never per member. */
  readonly shared: boolean;            // LAN: false, relay: true
  // start / stop / sendTo / broadcast / status: as in v0.3.0
  /** Resolves once a stop has finished flushing (LAN: socket closed; relay: bye acknowledged or 500 ms). */
  whenClosed(): Promise<void>;
  // events, as in v0.3.0: 'packet', 'peerGone', 'status'; new: 'linkUp' — a new link came up, send presence now
}
```

- `linkUp` is emitted by the relay transport each time a relay goes live. LAN keeps announcing on its `status` → `ok` as in v0.3.0.
- On a shared transport, `sendTo(peer, packet)` is the same as `broadcast(packet)`.
- `RelayTransport` never emits `peerGone`: relays have no per-peer connection. Members on the internet path leave by `bye` or by timeout.
- `PeerKey` for relay packets is `net:<sender pubkey hex>`.

### 3.3 RoomManager changes

- **One send per shared transport.** `sendPing` sends per member over LAN as before. If any member's live route is the relay transport, the packet is sent over it once.
- **Outgoing caps** live in RoomManager, because transports only see sealed bytes:
  - Pings over a shared transport: token bucket, 5/s, burst 10. A ping over the cap is not sent over relays. It still goes over LAN to LAN members.
  - Presence over a shared transport, when triggered by a change, a `linkUp`, or answering a new peer: at most once per second. The first goes out at once; any further requests in that second become one presence at its end, carrying the latest state. The 10 s periodic presence is unaffected.
- **Settle window:** "room full" is judged once the internet transport has left `starting`, or right away if it isn't running, plus 3 s. The window is capped at 15 s from the start of the join.
- **Timing per path:**

  | | LAN | Internet |
  |---|---|---|
  | Presence interval | 2 s | 10 s |
  | Path alive after last packet | 6 s | **25 s** (was 15 s) |
  | Member dropped after silence | 15 s | **30 s** once the member has been heard over the internet |

- **`setInternetAllowed(on)`:** while joining or active:
  - **on:** start the relay transport with the current keys, then announce over it.
  - **off:** stop the relay transport **without** sending bye. A bye makes the others ignore our peer ID for their whole session, which would also cut us off on LAN. Members reachable only over the internet see us as "disconnected" after their timeout.
  - When idle, it only records the flag for the next join. The internet status reads `off` while not allowed.
- **Retry** needs nothing from RoomManager: `index.ts` wires `room:retryInternet` straight to `RelayTransport.retryNow()`.

### 3.4 Keys

`deriveRoomKeys` keeps the same scrypt and HKDF steps.
- `sigRoomId` is renamed `relayTopic`, still derived with HKDF info `"sig-room"`, so the known-answer vectors don't change.
- `sigPassword` (info `"sig-pw"`) is removed.
- `RoomKeys` becomes `{ msgKey, relayTopic }`.
- The Nostr key pair is not derived from the code. It is random per join, made by `RelayTransport.start`, so different sessions can't be linked by key.

## 4. Relay protocol

### 4.1 Event

Standard NIP-01 event:

| Field | Value |
|---|---|
| `kind` | `24747`: ephemeral range (20000–29999), so relays forward it and don't store it |
| `tags` | `[["x", relayTopic]]`: 64 hex characters, derived from the code; reveals nothing without it |
| `content` | the sealed packet in base64 (≤ 1200 bytes → ≤ 1600 characters) |
| `created_at` | now, in seconds |
| `pubkey`, `id`, `sig` | the per-join key pair; id and signature per NIP-01 / BIP-340 |

### 4.2 Subscription

One subscription per relay: `["REQ", <sub id>, { "kinds": [24747], "#x": [relayTopic], "since": now − 600, "limit": 0 }]`.
- It is renewed after every reconnect.
- `since` matches the replay guard's ±10 min window, so a relay that wrongly stores ephemeral events can't replay older ones and raise false clock warnings.
- `limit: 0` asks for live events only.

### 4.3 Incoming

0. **Per relay, before parsing:** a binary frame (Nostr is text only), a message over 64 KB, or more than 400 messages within one second, retires that relay for the session. A well-behaved relay never comes close for our subscription. This keeps a malicious relay from spending our memory or CPU.
1. Parse the relay message. Anything that isn't a well-formed `EVENT` for our subscription, with our kind and our topic tag, is ignored.
2. **Our own events** (our pubkey) credit the relay they came from as echoed (§4.5) and stop here. This happens before the id check, so every relay that echoes gets credit, not only the first. They never reach RoomManager.
3. Drop events whose content is over 1600 characters or isn't base64.
4. Drop event ids seen recently. The same event arrives once per relay; the last 512 ids are remembered.
5. Drop everything above **200 events/s** in total, across all relays (counted after the id check).
6. Emit `packet` (`net:<pubkey>`, bytes). RoomManager decrypts, validates and replay-checks as before.

Signatures are not verified locally: relays already verify them, and the AES-GCM seal is what proves a packet came from someone with the code.

### 4.4 Outgoing

- Each packet becomes one event, signed once and published to every **live** relay (§4.5). Relays that are connecting, cooling, down or retired are skipped; nothing is queued for them.
- On `stop`, the transport sends nothing new. If the last event it published hasn't been acknowledged yet (the bye RoomManager just sent), it waits for that `OK`, at most 500 ms, then closes the sockets; an `OK` that already came clears the wait, so a stop with nothing pending closes at once.
- While it waits, relays that aren't live close at once and no relay reconnects: once stopped, no relay is contacted again, which keeps the "Allow internet connections" off promise.
- Quit awaits `whenClosed()`, as it already does for LAN.

### 4.5 Relay health and errors

Per-relay states: `connecting` → `live` ⇄ `cooling`; `down` (waiting to reconnect); `retired`.

- **Live** once the socket is open and subscribed. Going live emits `linkUp` (§3.2), so RoomManager announces over it at once rather than at the next 10 s round.
- A live relay is **healthy** once it has echoed one of our own events, and stays healthy while echoes keep coming within **25 s** of each other. Relays send matching events to every subscriber, the author included, and presence goes out every 10 s, so this is a true round-trip check.
- **No echo within 25 s** of going live or of the last echo, or the socket closes or errors → `down`. Reconnect after a backoff: 2 s, doubling to 60 s, ±20% jitter. Reset after 60 s of being healthy.
- **`OK false` with prefix:**
  - `rate-limited:` → `cooling` for 30 s. It isn't published to, and its missing echoes don't count against it.
  - `blocked:`, `restricted:`, `auth-required:`, `pow:` or `invalid:` → `retired` for this room session.
- **`CLOSED`** for our subscription → resubscribe once; a second `CLOSED` → `retired`.
- **`NOTICE`** is ignored. `AUTH` challenges (NIP-42) are not answered.
- **Wake from sleep:** every relay that isn't retired reconnects at once.

### 4.6 Transport status

- `starting` from `start` until the first relay echoes, then `ok`.
- `unavailable` if no relay echoes within **15 s**, as soon as every relay has failed before ever connecting (no internet at all, so a LAN party isn't held up), or when every relay later becomes unhealthy. Reconnects continue in the background, and status returns to `ok` on the next echo.
- `retryNow()` (the Room page's **Retry**) reconnects every relay that is down or retired immediately, with backoffs reset. Relays already connecting or live are left alone, so pressing it again never undoes a connection in progress. Waking from sleep reconnects every relay that isn't retired.

### 4.7 Constants

| Constant | Value |
|---|---|
| Event kind | 24747 |
| Relay health window | 25 s |
| Status `unavailable` after | 15 s without any echo |
| Backoff | 2 s → 60 s, ×2, ±20% |
| `rate-limited` cool-down | 30 s |
| Incoming budget | 200 events/s |
| Per-relay raw limits | binary frames, 64 KB per message, 400 messages/s → retired |
| Id dedupe memory | 512 events |
| Ping cap over relays | 5/s, burst 10 (the probe may lower it, §6.2) |
| Change-driven presence over relays | ≤ 1/s |
| Bye drain on stop | ≤ 500 ms |

## 5. Settings and IPC

- **Settings:** no new keys. `allowInternet` (bool, default `true`) already exists and has been saved since v0.3.0, so upgrading users get internet rooms turned on, as originally specified. Changing it calls `room.setInternetAllowed`.
- **IPC:** `room:retryInternet` (already in the v0.3.0 spec) is implemented. It goes from the settings window to main and on to `RelayTransport.retryNow()`.
- `RoomState` is unchanged. It already carries `internet: TransportStatus`, and members already carry `path: 'internet'`.

## 6. The probe gate

Nothing in §3–§5 is built until the probe passes.

### 6.1 Tool

- `tools/relay-probe/`: a Node script bundled with esbuild, like `tools/room-peer`.
- It imports the real `src/main/nostrEvent.ts`, so it also exercises our event code against real relays.
- It prints a table and writes a JSON report.
- It runs from this PC, on Node 22's built-in `WebSocket`.
- Test events use kind 24747 with a random topic and random content of real packet size. They are ephemeral and never stored.
- It sends about 250 events per relay. It is run only with the user's go-ahead.

**Candidates:** about 15 public relays. They are well-known general relays, such as `relay.damus.io`, `nos.lol`, `relay.primal.net`, `nostr.mom` and `offchain.pub`, plus several from Trystero's default list, which are known to accept ephemeral app events.

### 6.2 Criteria and decision

| Check | Pass |
|---|---|
| Connect and subscribe | ≤ 5 s |
| Accepts kind 24747 | `OK true` |
| Own-event round trip | median ≤ 1 s, 95th percentile ≤ 2 s |
| Burst: 30 s at 5 events/s | no `rate-limited`, ≥ 99% echoed |
| Soak: 10 min at one event per 10 s | no idle disconnects, or a clean reconnect if one happens |

- **4 or more relays pass:** go. Pin up to 6, preferring different operators and hosting.
- **Fewer than 4 pass the burst at 5/s:** rerun the burst at 2/s. If 4 or more then pass, go, with the relay ping cap lowered to 2/s and burst 4.
- **Fewer than 3 pass at all:** no-go. Stop, and revisit the design before any building.

### 6.3 The pinned list

- `src/main/relays.ts`: a plain array of `wss://` URLs, with a comment giving the probe date.
- **Compatibility rule**, written in that file: any later version must keep at least 3 relays from the previous version's list. Old and new versions can only meet on a relay both use.
- A relay that dies later just shows as unhealthy and is skipped. The others carry the room.

## 7. Privacy

- **Relays see:** your IP address, the room's topic (a hash that reveals nothing without the code), a throwaway public key that changes on every join, and the times and sizes of your encrypted messages.
- **Relays never see:** pings, names, colours or the code.
- **Other members:** on the same network they see your local IP address, as in v0.3.0. Over the internet they never see your IP.
- **Allow internet connections off:** no relay is ever contacted.

## 8. User experience

### 8.1 Room page

- **New switch "Allow internet connections"**, in the options above "Rejoin last room on launch". Description: "Meet friends on other networks through public relays. Off: same network only."
- **"Internet unavailable" card:**
  - Same style as "LAN unavailable".
  - Shown while in a room with the switch on and internet status `unavailable`.
  - Text: "Can't reach any relay. Retrying in the background."
  - Has a **Retry** button.
- **Member badges:** `Internet` now appears for members reached over relays. It is styled like `LAN`, in its own colour.
- **Alone with the switch off:** once the "Nobody here yet" hint shows (20 s), it adds "Friends on another network? Turn on Allow internet connections."
- **Privacy note and help text** are rewritten (§8.2).
- **Unchanged:** the tray, toasts and everything else on the page.

### 8.2 Strings (en / zh-CN)

| Key | en | zh-CN |
|---|---|---|
| `roomInternet` | Allow internet connections | 允许互联网连接 |
| `roomInternetDesc` | Meet friends on other networks through public relays. Off: same network only. | 通过公共中继与其他网络上的朋友连接。关闭后仅限同一网络。 |
| `roomInternetUnavailable` | Internet unavailable | 互联网不可用 |
| `roomInternetUnavailableDesc` | Can't reach any relay. Retrying in the background. | 无法连接任何中继，正在后台重试。 |
| `roomRetry` | Retry | 重试 |
| `roomLonelyInternetOff` | Friends on another network? Turn on Allow internet connections. | 朋友在其他网络？请打开“允许互联网连接”。 |
| `roomPrivacy` (replaced) | Pings and names are end-to-end encrypted. People on your network can see your local IP address. With internet connections on, public relays see your IP address, an anonymous room ID and when you send, but never your pings or your name. | 信号和名字均为端到端加密。同一网络中的人可以看到你的本地 IP 地址。开启互联网连接后，公共中继可以看到你的 IP 地址、匿名房间 ID 和发送时间，但永远看不到你的信号和名字。 |
| `roomHelp` (replaced) | Can't see a friend? Check that you both typed the same code. On the same network, lolPing must be allowed through the firewall; on different networks, you both need Allow internet connections on. | 看不到朋友？请确认你们输入的是同一个房间码。在同一网络中，需要允许 lolPing 通过防火墙；在不同网络中，双方都需要打开“允许互联网连接”。 |

### 8.3 Platform

Relays need only outgoing encrypted WebSocket connections. That means no Windows Firewall prompt, no new macOS permission or `Info.plist` entry, and no installer change.

## 9. Failure handling

| Situation | Behaviour |
|---|---|
| No relay reachable | Internet `unavailable` + card with Retry; reconnects keep going in the background; LAN unaffected |
| One relay down, slow or rate-limiting | Skipped (down / cooling / retired); the rest carry the room |
| Relay silently stops forwarding (no `OK false`) | No echo within 25 s → down → reconnect with backoff. The probe found 7 of 16 candidates doing this after 6–15 events, so none of them is pinned. |
| Relay requires auth or proof of work | Retired for the session |
| Relay storing and replaying ephemeral events | `since` and the replay guard drop them |
| Duplicate events from several relays | Dropped by event id before decryption; any that slip through are dropped by the replay guard |
| Junk on our topic | Fails decryption; incoming budget caps the CPU cost |
| Malicious relay: huge messages or a flood | Retired for the session (over 64 KB, or over 400 messages/s); the other relays carry the room |
| Relay sends events we didn't ask for | Ignored: wrong subscription, kind or topic tag |
| Sleep / resume, network change | Relays reconnect at once on resume; members get the existing sleep-gap grace |
| Switch turned off mid-room | Relay transport stops without bye; internet-only members time out on their side |
| Peer's clock off by more than 10 min | Relays filter or the replay guard drops their packets. The clock warning still comes from LAN. |
| Member on v0.3.0 | Reachable over LAN only, as before |

## 10. Testing

**Unit tests** (vitest, CI on Windows and macOS)
- `tests/main/nostrEvent.test.ts`:
  - Event id: the exact NIP-01 serialisation string (field order, no spaces) and its SHA-256.
  - Signing matches BIP-340 test vector 0 and verifies.
  - `parseRelayMessage` rejects junk: wrong types, bad JSON, huge strings, prototype-pollution keys.
- `tests/main/relayConnection.test.ts`, with a fake WebSocket and fake timers:
  - Subscribes, and resubscribes after a reconnect.
  - Backoff schedule and reset.
  - Health by echo; no echo → down.
  - Every `OK false` prefix; `CLOSED` once and twice.
  - A binary frame, a message over 64 KB, or over 400 messages in a second → retired; events with another sub id, kind or tag → ignored.
  - Retry leaves connecting and live relays alone.
  - Wake → reconnect.
- `tests/main/relayPool.test.ts`:
  - Publishes to live relays only; a fresh relay gets events before its first echo.
  - Own echoes credit every relay they arrive from, before the id dedupe, and never reach RoomManager.
  - Dedupes across relays; enforces the incoming budget.
  - Status `starting` → `ok` → `unavailable` → `ok`.
  - `retryNow` revives retired relays.
  - `unavailable` as soon as every relay has failed before connecting.
- `tests/main/relayTransport.test.ts`:
  - Base64 round trip; oversize dropped.
  - New key pair per start.
  - Bye drain ≤ 500 ms on stop; at once when the last event was already acknowledged.
  - While draining, relays that aren't live close at once and none reconnects.
  - Under RoomManager, flipping "Allow internet connections" off and on leaves one open socket per relay.
- `tests/main/roomManager.test.ts` additions:
  - A shared transport gets exactly one send per ping.
  - Ping cap 5/s with burst 10, while presence and bye pass.
  - Change-driven and `linkUp` presence: first at once, the rest coalesced into one at the end of the second.
  - Joining over relays only: presence goes out as soon as the first relay is live, not at the 10 s round.
  - Settle waits for the internet transport, with the 15 s cap.
  - Internet path alive for 25 s and drop after 30 s.
  - `setInternetAllowed` on and off mid-room, with no bye on off.
  - LAN preferred, falling back to internet when LAN goes quiet.
- `tests/main/roomCrypto.test.ts`: vectors unchanged; the `sigPassword` assertion is removed.

**Integration test:** `tests/main/relayRoom.test.ts`.
- A minimal fake Nostr relay runs in-process (`ws` as a new devDependency). It handles `REQ`/`EVENT`/`OK`/`CLOSE` and echoes to every subscriber.
- Two RoomManager + RelayTransport pairs discover each other, exchange a ping, and one leaves with bye.
- Hybrid case: LAN + relay with LAN blocked → path `internet`; unblock LAN → path `lan`.

**Tools**
- `tools/relay-probe`: the gate (§6).
- `tools/room-peer --relay`: joins a room through the real pinned relays only, so one PC can test the app end to end over the internet path (badge `Internet`).
- Development builds read `LOLPING_RELAYS`, a comma-separated list of `wss://` URLs, in place of the pinned list. That lets the "Internet unavailable" state and Retry be tested without touching the firewall. Packaged builds ignore it.

**Manual checklist** (run before release; recorded in the checklist file):
1. Windows ↔ Windows on different networks (one on a phone hotspot): join, pings both ways, `Internet` badge, name tags, how fast pings feel.
2. Windows ↔ macOS on different networks.
3. Same network with internet allowed: badge stays `LAN`; pull LAN (e.g. switch Wi-Fi) → `Internet` within ~25 s.
4. Turn "Allow internet connections" off and on mid-room; the hint when alone with it off.
5. All relays blocked (e.g. firewall rule) → "Internet unavailable" card; unblock + Retry → back to `ok`.
6. Sleep/resume mid-room over the internet; rejoin on launch.
7. Spam over the internet with Unlimited on the receiver: the cap holds, the app stays responsive.

## 11. Delivery → v0.4.0

1. `tools/relay-probe` (with `nostrEvent.ts`); run after the user's go-ahead; decide go/no-go; pin `relays.ts` and the ping cap.
2. `nostrEvent`, `RelayConnection`, `RelayPool`, `RelayTransport` + unit tests. New runtime dependency `@noble/secp256k1`; dev dependency `ws`.
3. `Transport.shared`/`whenClosed`, RoomManager changes, key rename + tests; `relayRoom` integration test.
4. Wiring in `src/main/index.ts`:
   - Create the relay transport.
   - Reconnect on `powerMonitor` resume.
   - Apply `allowInternet` changes live.
   - `room:retryInternet` handler.
   - Quit awaits `whenClosed()` on both transports.
5. Room page: switch, unavailable card with Retry, `Internet` badge style, hint, privacy and help text; en + zh-CN; `prototype/room-demo.html` updated.
6. `tools/room-peer --relay`.
7. Docs:
   - README + README.zh-CN: internet rooms, what relays see, the Tailscale note (now just uses the internet path), the `relay-probe` tool row.
   - `docs/design.md` §12: the relay transport.
   - A pointer in the v0.3.0 spec's §5.5 to this spec.
   - `package.json` version 0.4.0.
8. Independent review → fixes → a subagent verifies every one-PC item (dev app over CDP + `room-peer --relay`) → checklist for the user's real-device checks.

The spec, the code and the docs land in **one commit**, only after everything is built and tested.

## 12. Out of scope

- Direct WebRTC between members. It's a possible later upgrade behind the same `Transport` interface if relayed pings ever feel slow.
- TURN, or any server run by the project.
- A user-editable relay list.
- Rotating the relay topic over time.
- Changing the code length or anything else the v0.3.0 spec puts out of scope.
