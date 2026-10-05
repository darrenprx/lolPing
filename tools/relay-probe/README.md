# relay-probe

Checks which public Nostr relays can carry lolPing's internet rooms. It decides the pinned list in `src/main/relays.ts`.

```bash
node tools/relay-probe/run.mjs                          # all candidates, burst 5/s, 10 min soak
node tools/relay-probe/run.mjs --relays wss://nos.lol --soak-min 0
node tools/relay-probe/run.mjs --burst-rate 2 --soak-min 0
```

For each relay, in parallel:

1. **Connect** and subscribe.
2. **Round trips:** 20 events, 500 ms apart. Measures how fast our own events come back.
3. **Burst:** 30 s at `--burst-rate` events per second, the ping cap. Counts `rate-limited` replies and lost echoes.
4. **Soak:** one event every 10 s, the presence pace, for `--soak-min` minutes. Counts idle disconnects and checks that reconnecting works.

A relay passes when it:

- connects within 5 s;
- accepts kind 24747;
- echoes with a median of 1 s or less and a 95th percentile of 2 s or less;
- isn't rate-limited during the burst, and echoes at least 99% of it;
- reconnects cleanly after any drop in the soak.

**What it sends:**

- About 250 ephemeral events per relay (kind 24747). Relays forward these and don't store them.
- Each relay gets a throwaway key and a random topic. The content is random bytes the size of a real room packet.
- Like any website, each relay sees this machine's IP address.

**Output:** a table on the console. The full report goes to `<temp>/lolping-relay-probe.json`.
