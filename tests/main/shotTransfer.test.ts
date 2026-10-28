import { describe, expect, it } from 'vitest';
import { ShotTransfer, shotHash } from '../../src/main/shotTransfer';
import { SHOT_CHUNK_BYTES, type ShotBody, type ShotMeta } from '../../src/shared/roomShots';

const A = 'a'.repeat(16), B = 'b'.repeat(16);
const image = (data: Uint8Array, id = '1'.repeat(16), rev = 1): ShotMeta => ({
  t: 'shot', id, rev, d: 1, x: 0.3, y: 0.4, w: 640, h: 360, bytes: data.length,
  hash: shotHash(data), marks: [{ x: 0.5, y: 0.5, n: 1 }], status: 'ready',
});
function link(lane: 'lan' | 'shared' = 'lan') {
  let now = 0, connected = true;
  const complete: { meta: ShotMeta; data: Uint8Array }[] = [], failed: ShotMeta[] = [], metadata: ShotMeta[] = [];
  const packets: ShotBody[] = [];
  let filter: (body: ShotBody) => boolean = () => true;
  const sender = new ShotTransfer({ now: () => now, self: () => A, peers: () => connected ? [{ peer: B, lane }] : [],
    send: (_peer, body) => { packets.push(body); if (filter(body)) receiver.receive(A, body); return true; },
    metadata: () => undefined, completed: () => undefined, failed: () => undefined });
  const receiver = new ShotTransfer({ now: () => now, self: () => B, peers: () => [{ peer: A, lane }],
    send: (_peer, body) => { sender.receive(B, body); return true; },
    metadata: (_peer, meta) => metadata.push(meta), completed: (_peer, meta, data) => complete.push({ meta, data }),
    failed: (_peer, meta) => failed.push(meta) });
  const pump = (ticks = 1, step = 25): void => {
    for (let i = 0; i < ticks; i++) { now += step; sender.tick(); receiver.tick(); }
  };
  return { sender, receiver, complete, failed, metadata, packets, pump,
    at: (t: number) => { now = t; }, filter: (fn: typeof filter) => { filter = fn; }, connect: (v: boolean) => { connected = v; } };
}

describe('ShotTransfer', () => {
  it.each(['lan', 'shared'] as const)('transfers the complete image with verified hash over %s', (lane) => {
    const h = link(lane), data = Uint8Array.from({ length: 8500 }, (_, i) => i % 251);
    h.sender.publish(image(data), data); h.pump(30);
    expect(h.complete).toHaveLength(1); expect(h.complete[0].data).toEqual(data);
    expect(h.metadata).toHaveLength(1); expect(h.receiver.stats.bytes).toBe(0);
    const parts = h.packets.filter((p) => p.t === 'shotParts');
    expect(parts.length).toBe(lane === 'lan' ? Math.ceil(data.length / SHOT_CHUNK_BYTES) : 1);
  });
  it('requests and recovers a missing part, even when metadata or duplicate packets arrive again', () => {
    const h = link(), data = new Uint8Array(1800).fill(17);
    let dropped = false;
    h.filter((p) => { if (p.t === 'shotParts' && p.parts[0].i === 1 && !dropped) { dropped = true; return false; } return true; });
    h.sender.publish(image(data), data); h.pump(5); expect(h.complete).toHaveLength(0);
    h.pump(160); expect(h.complete).toHaveLength(1); expect(h.metadata).toHaveLength(1);
  });
  it('recovers after parts arrived before their metadata', () => {
    const h = link(), data = new Uint8Array(1500).fill(3);
    let lost = false;
    h.filter((p) => { if (p.t === 'shot' && !lost) { lost = true; return false; } return true; });
    h.sender.publish(image(data), data); h.pump(300);
    expect(h.complete).toHaveLength(1);
  });
  it('ignores late old revisions and replaces incomplete work when the capture grows', () => {
    const h = link(), old = new Uint8Array(1200).fill(1), fresh = new Uint8Array(1800).fill(2);
    h.sender.publish(image(old), old); h.pump();
    h.sender.publish(image(fresh, '1'.repeat(16), 2), fresh); h.pump(10);
    h.receiver.receive(A, image(old));
    expect(h.complete).toHaveLength(1); expect(h.complete[0].meta.rev).toBe(2); expect(h.metadata).toHaveLength(2);
  });
  it('rejects corrupted image bytes and starts a later capture normally', () => {
    const h = link(), data = new Uint8Array(600).fill(1), meta = image(data);
    h.receiver.receive(A, meta);
    h.receiver.receive(A, { t: 'shotParts', id: meta.id, rev: 1, d: 1, to: B,
      parts: [{ i: 0, b: Buffer.alloc(600, 2).toString('base64') }] });
    expect(h.complete).toHaveLength(0); expect(h.failed).toHaveLength(1);
    h.sender.publish(image(data, '2'.repeat(16)), data); h.pump(5); expect(h.complete).toHaveLength(1);
  });
  it('times out without recreating an expired assembly from periodic metadata, then accepts a new group', () => {
    const h = link(), data = new Uint8Array(1200).fill(3);
    h.filter((p) => p.t !== 'shotParts'); h.sender.publish(image(data), data); h.pump(600);
    expect(h.failed).toHaveLength(1); expect(h.receiver.stats.receiving).toBe(0);
    h.filter(() => true); h.sender.publish(image(data, '3'.repeat(16)), data); h.pump(8);
    expect(h.complete).toHaveLength(1);
  });
  it('keeps at most eight incoming and eight outgoing images and clears partial data on exit', () => {
    const h = link(), data = new Uint8Array(1200);
    for (let i = 1; i <= 12; i++) {
      const m = image(data, i.toString(16).padStart(16, '0'));
      h.sender.publish(m, data); h.receiver.receive(A, m);
    }
    expect(h.sender.stats.sending).toBe(8); expect(h.receiver.stats.receiving).toBe(8);
    h.sender.clear(); h.receiver.clear();
    expect(h.sender.stats.sending).toBe(0); expect(h.receiver.stats).toMatchObject({ receiving: 0, bytes: 0 });
  });
  it('keeps an image for a reconnect within its deadline, then releases outgoing data', () => {
    const h = link(), data = new Uint8Array(1200).fill(3);
    h.connect(false); h.sender.publish(image(data), data); h.pump(20); expect(h.complete).toHaveLength(0);
    h.connect(true); h.pump(5); expect(h.complete).toHaveLength(1);
    h.at(50_000); h.pump(); expect(h.sender.stats.sending).toBe(0);
  });
  it('does not send snapshots after cancellation, and rejects parts addressed to another member', () => {
    const h = link(), data = new Uint8Array(600).fill(3), meta = image(data);
    h.sender.publish(meta, data); h.sender.cancelSending(); h.pump(); expect(h.packets).toHaveLength(0);
    h.receiver.receive(A, meta);
    h.receiver.receive(A, { t: 'shotParts', id: meta.id, rev: 1, d: 1, to: 'c'.repeat(16),
      parts: [{ i: 0, b: Buffer.from(data).toString('base64') }] });
    expect(h.complete).toHaveLength(0);
    h.receiver.forget(A); expect(h.receiver.stats.receiving).toBe(0);
  });
});
