import type { MediaApi, MediaCommand, MediaConfig, MediaSignal } from '../../shared/roomMedia';

interface Link {
  pc: RTCPeerConnection;
  id: string;
  channel: RTCDataChannel | null;
  queue: Uint8Array[];
  started: number;
  open: boolean;
  localSignal?: MediaSignal;
  publishedAt?: number;
  cancelGather?: () => void;
}

/** A reliable data-only connection. Room identity and payload authentication stay in main. */
export class RoomMediaEngine {
  private self = '';
  private config: MediaConfig = { iceServers: [], iceTransportPolicy: 'all' };
  private peers = new Set<string>();
  private links = new Map<string, Link>();
  private retryAt = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly api: Pick<MediaApi, 'emit'>,
    private readonly makePeer = (config: RTCConfiguration) => new RTCPeerConnection(config),
    private readonly now = Date.now) {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  command(c: MediaCommand): void {
    if (c.t === 'reset') {
      for (const peer of this.links.keys()) this.drop(peer);
      this.peers.clear();
      this.retryAt.clear();
      this.self = c.self;
      this.config = c.config;
    } else if (c.t === 'peers') {
      this.peers = new Set(c.peers.filter((p) => p !== this.self));
      for (const p of this.links.keys()) if (!this.peers.has(p)) this.drop(p);
      for (const p of this.retryAt.keys()) if (!this.peers.has(p)) this.retryAt.delete(p);
      this.tick();
    } else if (c.t === 'signal') {
      const pending = this.signal(c.peer, c.signal);
      const link = this.links.get(c.peer);
      void pending.catch(() => { if (link && this.links.get(c.peer) === link) this.fail(c.peer); });
    } else {
      const link = this.links.get(c.peer);
      if (!link?.open || c.bytes.length > 1200 || !c.bytes.length) return;
      if (link.queue.length >= 256) return;
      link.queue.push(c.bytes);
      this.drain(c.peer, link);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.peers.clear();
    for (const peer of this.links.keys()) this.drop(peer);
  }

  private tick(): void {
    for (const peer of this.peers) {
      const link = this.links.get(peer);
      if (link && !link.open && this.now() - link.started > 45_000) this.fail(peer);
      else if (link && !link.open && link.localSignal && this.now() - (link.publishedAt ?? 0) >= 10_000) {
        // Presence and relay delivery can race the first offer; retry the same bounded negotiation.
        link.publishedAt = this.now();
        this.api.emit({ t: 'signal', peer, signal: link.localSignal });
      }
      if (!this.links.has(peer) && this.self < peer && this.now() >= (this.retryAt.get(peer) ?? 0)) {
        try {
          const pending = this.offer(peer);
          const current = this.links.get(peer);
          void pending.catch(() => { if (current && this.links.get(peer) === current) this.fail(peer); });
        } catch { this.retryAt.set(peer, this.now() + 30_000); }
      }
    }
  }

  private create(peer: string, id: string): Link {
    const pc = this.makePeer(this.config);
    const link: Link = { pc, id, channel: null, queue: [], started: this.now(), open: false };
    this.links.set(peer, link);
    this.api.emit({ t: 'status', peer, status: 'connecting' });
    pc.onconnectionstatechange = () => {
      if (this.links.get(peer) !== link) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') this.fail(peer);
    };
    pc.ondatachannel = (event) => this.attach(peer, link, event.channel);
    return link;
  }

  private attach(peer: string, link: Link, channel: RTCDataChannel): void {
    if (link.channel || channel.label !== 'lolping-emotes' || channel.ordered !== true ||
      channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) { channel.close(); return; }
    link.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 32 * 1024;
    channel.onopen = () => {
      if (this.links.get(peer) !== link) return;
      link.open = true;
      this.api.emit({ t: 'status', peer, status: 'connected' });
      this.drain(peer, link);
    };
    channel.onbufferedamountlow = () => this.drain(peer, link);
    channel.onclose = channel.onerror = () => { if (this.links.get(peer) === link) this.fail(peer); };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (this.links.get(peer) !== link || !this.peers.has(peer)) return;
      if (event.data instanceof ArrayBuffer && event.data.byteLength > 0 && event.data.byteLength <= 1200) {
        this.api.emit({ t: 'packet', peer, bytes: new Uint8Array(event.data) });
      }
    };
  }

  private drain(peer: string, link: Link): void {
    const channel = link.channel;
    if (this.links.get(peer) !== link || !channel || channel.readyState !== 'open') return;
    try {
      while (link.queue.length && channel.bufferedAmount < 64 * 1024) {
        const packet = link.queue.shift();
        if (packet) channel.send(new Uint8Array(packet).buffer);
      }
    } catch { this.fail(peer); }
  }

  private async offer(peer: string): Promise<void> {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    const link = this.create(peer, id);
    this.attach(peer, link, link.pc.createDataChannel('lolping-emotes', { ordered: true }));
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await this.publish(peer, link, 'offer');
  }

  private async signal(peer: string, signal: MediaSignal): Promise<void> {
    if (!this.peers.has(peer)) return;
    if (signal.type === 'offer') {
      if (this.self < peer) return;
      const existing = this.links.get(peer);
      if (existing?.id === signal.id || existing?.open) return;
      this.drop(peer);
      const link = this.create(peer, signal.id);
      await link.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      if (this.links.get(peer) !== link) return;
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      await this.publish(peer, link, 'answer');
    } else {
      const link = this.links.get(peer);
      if (!link || link.id !== signal.id || link.pc.signalingState !== 'have-local-offer') return;
      await link.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    }
  }

  private async publish(peer: string, link: Link, type: 'offer' | 'answer'): Promise<void> {
    if (link.pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          link.pc.removeEventListener('icegatheringstatechange', changed);
          link.cancelGather = undefined;
          resolve();
        };
        const changed = () => { if (link.pc.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, 8000);
        link.cancelGather = done;
        link.pc.addEventListener('icegatheringstatechange', changed);
        changed();
      });
    }
    const sdp = link.pc.localDescription?.sdp;
    if (this.links.get(peer) !== link || !this.peers.has(peer) || !sdp || sdp.length > 30_000) return;
    link.localSignal = { id: link.id, type, sdp };
    link.publishedAt = this.now();
    this.api.emit({ t: 'signal', peer, signal: link.localSignal });
  }

  private fail(peer: string): void {
    this.drop(peer);
    if (!this.peers.has(peer)) return;
    this.retryAt.set(peer, this.now() + 30_000);
    this.api.emit({ t: 'status', peer, status: 'failed' });
  }

  private drop(peer: string): void {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    link.cancelGather?.();
    link.queue = [];
    link.channel?.close();
    link.pc.close();
    this.api.emit({ t: 'status', peer, status: 'off' });
  }
}
