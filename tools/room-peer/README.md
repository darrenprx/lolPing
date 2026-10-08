# room-peer

A fake room member, for trying rooms with one computer. It joins a room, announces itself, drops random pings and prints the pings and emotes it receives.

```bash
node tools/room-peer/run.mjs PING-XXXXX-XXXXX --name Bot --rate 1
```

| Option | Default | |
| --- | --- | --- |
| `--name` | `Bot` | Name shown under its pings |
| `--color` | `4` | Tag colour, 0–7 |
| `--rate` | `1` | Pings per second; `0` only listens, `20` tests the spam limit (at most 5 with `--relay`) |
| `--host` | `127.0.0.1` | Address of the machine running lolPing (LAN only) |
| `--port` | `47475` | This peer's own UDP port; lolPing uses 47474 (LAN only) |
| `--display` | `1` | Display number its pings target |
| `--relay` | off | Join through the public relays instead of the LAN |
| `--emotes` | off | Also send emotes (see below) |

Start lolPing, create a room, copy the code and run the command with it. Several peers can run at once on different ports.

## Emotes

With `--emotes` the peer alternates pings and random bundled emotes at `--rate`, so the total stays at that rate, and every 10 s it sends an emote of a made-up own image (`c:` and 32 hex characters). lolPing has no such image, so it shows the "?" placeholder. Emotes it receives print as `[in] emote <ref> on display <d> at x, y`. With `--rate 0` it only listens.

```bash
node tools/room-peer/run.mjs PING-XXXXX-XXXXX --emotes --rate 0.5
```

## Over the internet path

With `--relay` the peer never touches the LAN: it reaches the room only through the relays pinned in `src/main/relays.ts`, like a friend on another network would. lolPing should list it with an `Internet` badge within a few seconds.

```bash
node tools/room-peer/run.mjs PING-XXXXX-XXXXX --relay --name Remote
```
