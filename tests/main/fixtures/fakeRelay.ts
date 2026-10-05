import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

interface Filter { kinds: number[]; topics: string[] }

/**
 * Just enough of a Nostr relay for tests: subscriptions by kind and "#x" tag, OK for every event, and each event sent
 * to every matching subscription, the author's included. `since` and `limit` are ignored: nothing is stored.
 */
export async function startFakeRelay(): Promise<{ url: string; close(): Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const subs = new Map<WebSocket, Map<string, Filter>>();
  wss.on('connection', (ws) => {
    const mine = new Map<string, Filter>();
    subs.set(ws, mine);
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let m: unknown[];
      try {
        m = JSON.parse(String(raw)) as unknown[];
      } catch {
        return;
      }
      if (m[0] === 'REQ') {
        const f = m[2] as { kinds?: number[]; '#x'?: string[] };
        mine.set(String(m[1]), { kinds: f.kinds ?? [], topics: f['#x'] ?? [] });
        ws.send(JSON.stringify(['EOSE', m[1]]));
      } else if (m[0] === 'CLOSE') {
        mine.delete(String(m[1]));
      } else if (m[0] === 'EVENT') {
        const e = m[1] as { id: string; kind: number; tags: string[][] };
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        for (const [peer, filters] of subs) {
          for (const [id, f] of filters) {
            if (f.kinds.includes(e.kind) && e.tags.some((t) => t[0] === 'x' && f.topics.includes(t[1]))) {
              peer.send(JSON.stringify(['EVENT', id, e]));
            }
          }
        }
      }
    });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
