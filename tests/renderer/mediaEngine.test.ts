import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomMediaEngine } from '../../src/renderer/media/engine';
import type { MediaEvent } from '../../src/shared/roomMedia';

class Channel {
  label = 'lolping-emotes'; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
  readyState = 'connecting'; bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = '';
  sent: ArrayBuffer[] = [];
  onopen = () => {}; onclose = () => {}; onerror = () => {}; onbufferedamountlow = () => {};
  onmessage = (_event: MessageEvent<unknown>) => {};
  send(bytes: ArrayBuffer) { this.sent.push(bytes); }
  close() { this.readyState = 'closed'; this.onclose(); }
  open() { this.readyState = 'open'; this.onopen(); }
}
const SDP = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
class Peer {
  channel = new Channel(); connectionState = 'new'; iceGatheringState = 'complete'; signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange = () => {}; ondatachannel = (_event: RTCDataChannelEvent) => {};
  listeners = new Set<() => void>();
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: 'offer' as const, sdp: SDP }; }
  async createAnswer() { return { type: 'answer' as const, sdp: SDP }; }
  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc; this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit) { this.remoteDescription = desc; this.signalingState = 'stable'; }
  addEventListener(_type: string, cb: () => void) { this.listeners.add(cb); }
  removeEventListener(_type: string, cb: () => void) { this.listeners.delete(cb); }
  close() { this.connectionState = 'closed'; this.onconnectionstatechange(); }
}
const engines: RoomMediaEngine[] = [];
function harness(self = 'a'.repeat(16)) {
  const peers: Peer[] = []; const events: MediaEvent[] = [];
  const engine = new RoomMediaEngine({ emit: (event) => events.push(event) }, () => {
    const peer = new Peer(); peers.push(peer); return peer as unknown as RTCPeerConnection;
  });
  engines.push(engine);
  engine.command({ t: 'reset', self, config: { iceServers: [], iceTransportPolicy: 'all' } });
  return { engine, peers, events };
}
const remote = 'b'.repeat(16);
const settled = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const e of engines.splice(0)) e.stop(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('RoomMediaEngine', () => {
  it('retries lost offers and answers without replacing the connection and stops once open', async () => {
    const offerer = harness(); offerer.engine.command({ t: 'peers', peers: [remote] }); await settled();
    const responder = harness('c'.repeat(16)); responder.engine.command({ t: 'peers', peers: [remote] });
    responder.engine.command({ t: 'signal', peer: remote, signal: { id: '1'.repeat(16), type: 'offer', sdp: SDP } });
    await settled();
    for (const h of [offerer, responder]) expect(h.events.filter((e) => e.t === 'signal')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    for (const h of [offerer, responder]) {
      const sent = h.events.filter((e) => e.t === 'signal');
      expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
      expect(h.peers).toHaveLength(1);
      if (h === responder) h.peers[0].ondatachannel({ channel: h.peers[0].channel } as unknown as RTCDataChannelEvent);
      h.peers[0].channel.open();
    }
    await vi.advanceTimersByTimeAsync(20_000);
    for (const h of [offerer, responder]) expect(h.events.filter((e) => e.t === 'signal')).toHaveLength(2);
  });

  it('has one offerer per pair, ignores stale answers and accepts the matching answer', async () => {
    const h = harness(); h.engine.command({ t: 'peers', peers: [remote] }); await settled();
    const signal = h.events.find((e) => e.t === 'signal');
    if (!signal || signal.t !== 'signal') throw new Error('missing offer');
    h.engine.command({ t: 'signal', peer: remote, signal: { id: 'f'.repeat(16), type: 'answer', sdp: SDP } }); await settled();
    expect(h.peers[0].remoteDescription).toBeNull();
    h.engine.command({ t: 'signal', peer: remote, signal: { ...signal.signal, type: 'answer' } }); await settled();
    expect(h.peers[0].remoteDescription?.type).toBe('answer');
    const responder = harness('c'.repeat(16)); responder.engine.command({ t: 'peers', peers: [remote] });
    expect(responder.peers).toHaveLength(0);
  });

  it('bounds buffered data and drops queued packets when a peer leaves', async () => {
    const h = harness(); h.engine.command({ t: 'peers', peers: [remote] }); await settled();
    const channel = h.peers[0].channel; channel.open(); channel.bufferedAmount = 100_000;
    for (let i = 0; i < 300; i++) h.engine.command({ t: 'packet', peer: remote, bytes: new Uint8Array([i % 256]) });
    expect(channel.sent).toHaveLength(0);
    channel.bufferedAmount = 0; channel.onbufferedamountlow();
    expect(channel.sent).toHaveLength(256);
    h.engine.command({ t: 'packet', peer: remote, bytes: new Uint8Array(1201) });
    expect(channel.sent).toHaveLength(256);
    h.engine.command({ t: 'peers', peers: [] });
    channel.onmessage(new MessageEvent('message', { data: new Uint8Array([1]).buffer }));
    expect(h.events.filter((e) => e.t === 'packet')).toHaveLength(0);
    expect(h.peers[0].connectionState).toBe('closed');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.peers).toHaveLength(1);
  });

  it('times out failed negotiations and retries only after the cooldown', async () => {
    const h = harness(); h.engine.command({ t: 'peers', peers: [remote] }); await settled();
    await vi.advanceTimersByTimeAsync(46_000);
    expect(h.events.some((e) => e.t === 'status' && e.status === 'failed')).toBe(true);
    expect(h.peers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(h.peers).toHaveLength(2);
  });

  it('cancels ICE gathering and pending signalling when reset disables the session', async () => {
    const h = harness(); h.engine.command({ t: 'peers', peers: [remote] });
    h.peers[0].iceGatheringState = 'gathering'; await settled();
    expect(h.peers[0].listeners.size).toBe(1);
    h.engine.command({ t: 'reset', self: 'c'.repeat(16), config: { iceServers: [], iceTransportPolicy: 'relay' } });
    await settled(); await vi.advanceTimersByTimeAsync(10_000);
    expect(h.peers[0].listeners.size).toBe(0);
    expect(h.events.filter((e) => e.t === 'signal')).toHaveLength(0);
  });
});
