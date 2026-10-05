import type { SocketFactory, SocketLike } from '../../../src/main/relayConnection';

/** A WebSocket stand-in: tests open it, push messages in and read what was sent. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  /** Like a real socket, closing it ourselves fires no onclose we'd still listen to. */
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: unknown[] | string): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }

  /** The relay or the network closes it. */
  drop(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  /** Everything sent, parsed. */
  messages(): unknown[][] {
    return this.sent.map((s) => JSON.parse(s) as unknown[]);
  }
}

export function fakeSockets(): { factory: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  };
}
