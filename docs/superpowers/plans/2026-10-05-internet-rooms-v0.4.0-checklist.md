# v0.4.0 (internet rooms): verification checklist

Everything is on branch `rooms-internet` and is **uncommitted**. It becomes one commit after your go-ahead.

**Automated checks already pass:**
- `npm run typecheck`
- `npm test`: 339 tests
- `npm run test:helper`: 284
- `npm run build`, `npm run build:site` and `npm run dist`, which produce `release/lolPing-Setup-0.4.0.exe`

**The relay probe passed.** All 6 pinned relays met every check in a full rerun:
- median round trip 100–400 ms;
- 30 s at 5 events/s with nothing dropped or rate-limited;
- a 10-minute soak with no disconnects.

**Already confirmed on this PC.** A dev build ran against the real pinned relays, with `tools/room-peer --relay` as a friend reachable only over the internet:
- Creating a room: internet `ok` in about 1.5 s, room active in about 4.4 s.
- The relay-only peer appeared with the blue `Internet` badge 0.6 s after it started.
- Pings went both ways: 10 of 10 to the app, 3 of 3 from the app.
- Turning **Allow internet connections** off closed all 6 relay sockets at once. Turning it back on reconnected within 1.2 s, and quick off/on flips left exactly 6 sockets.
- Leaving and rejoining the same code works.
- With no relay reachable (dev-only `LOLPING_RELAYS=wss://127.0.0.1:9`):
  - "Internet unavailable" showed within 0.2 s, and the room still became active after 3 s instead of 15 s.
  - Retry pressed 8 times caused no errors.
- Quitting while in a room exits in under 0.2 s.

What follows needs a second device, a second network, or a Mac.

## Before you start

- Install `release/lolPing-Setup-0.4.0.exe` on each Windows PC. On a Mac, build with `npm run dist:mac`, or use the CI build.
- **Allow internet connections** is on by default (Settings → Room).
- For a second network, a phone hotspot is easiest.

## 1. Two networks, Windows ↔ Windows

1. PC A on home Wi-Fi, PC B on a phone hotspot (or a friend's PC at their place). PC A: **Create room**, then send the code to B.
2. PC B: **Join from clipboard**. Within a few seconds, each side lists the other with a blue **Internet** badge.
3. Ping on each side. The ping lands at the same relative spot with the sender's name tag.
   - It should feel quick: well under a second.
   - Note roughly how long it takes.
4. Rename yourself or change your tag colour. The other side updates within a couple of seconds.

## 2. Two networks, Windows ↔ Mac

1. Same as section 1, with the Mac on the other network.
2. The Mac needs no new permission for relays. (Local Network is still asked for LAN.)

## 3. LAN and internet together

1. Both PCs on the same Wi-Fi with internet allowed. The badge shows **LAN**.
2. Move one PC to the hotspot without leaving the room. Within about 25 s, the badge on the other PC turns **Internet**, and pings keep working.
3. Move it back. The badge returns to **LAN**.

## 4. The switch and the warning

1. In a room with a friend over the internet, turn **Allow internet connections** off.
   - Your internet status goes off at once. The friend disappears from your list, and you from theirs within about 30 s.
   - Turn it back on. You find each other again within about 10 s.
2. Alone in a room with the switch off: after 20 s, the hint "Friends on another network? Turn on Allow internet connections." appears.
3. Optional:
   - Block lolPing in the firewall or turn off the network adapter while in a room. "Internet unavailable" appears with **Retry**.
   - Restore the network and press **Retry**. The card goes away within a few seconds.

## 5. Sleep, rejoin, spam

1. Sleep one PC for a minute while in an internet room, then wake it. The friend comes back by themselves.
   - Expect a brief "Internet unavailable" flash while the relays reconnect (see deferred items).
2. With **Rejoin last room on launch** on: quit and restart. The app rejoins the room over the internet.
3. Friend sets **Incoming ping limit** to **Unlimited**, and you spam pings over the internet. They see at most about 5 a second plus a short burst (the relay cap), and both PCs stay responsive.

## 6. Mixed versions and a LAN regression pass

1. One PC on v0.3.0 and one on v0.4.0, on the same Wi-Fi: they still see each other over **LAN**.
2. Quickly repeat sections 1, 3 and 4 of the v0.3.0 checklist (same-network pings, mute and limits, leave and rejoin). Nothing about LAN rooms should have changed.

## Deferred (known minor, not fixed in v0.4.0)

- **Waking from sleep:** a brief "Internet unavailable" flash until the first relay answers again.
- **First announcement:** the first presence over relays at join, or when switching internet on, can wait up to 1 s.
- **Silent network switch** (Wi-Fi changes without sleep): internet friends drop and rejoin after about 30 s, with "disconnected" and "joined" toasts.
- **Turning internet off:** internet-only friends leave your list after 0–30 s (it depends on when they joined), not after a fixed delay.
- **Message-rate limit:** a relay that delivers more than 400 messages a second is dropped for the session. Someone who knows the room's relay topic (a relay operator or a member) could use that to knock a relay out until Retry.
- **Settle cap:** the 15 s "room full" cap is measured from after key derivation, 100–300 ms late.
