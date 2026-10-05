import type { EventEmitter } from 'node:events';
import type { TransportStatus } from '../shared/room';
import type { RoomKeys } from './roomCrypto';

export type { TransportStatus };
/** A transport-local address, e.g. "lan:192.168.1.20:47474" or "net:<relay pubkey>". */
export type PeerKey = string;

/**
 * Moves sealed room packets and nothing else: keys, validation and every decision stay in RoomManager.
 * Events: 'packet' (peer: PeerKey, packet: Uint8Array), 'peerGone' (peer: PeerKey), 'status' (TransportStatus),
 * 'linkUp' (a new link came up: send presence now).
 */
export interface Transport extends EventEmitter {
  readonly kind: 'lan' | 'internet';
  /** One send reaches every member (relays): RoomManager sends each packet once, never per member. */
  readonly shared: boolean;
  readonly status: TransportStatus;
  start(keys: RoomKeys): void;
  /** Sends nothing: RoomManager says bye before stopping. */
  stop(): void;
  sendTo(peer: PeerKey, packet: Uint8Array): void;
  /** LAN: UDP broadcast. Internet: every connected peer. */
  broadcast(packet: Uint8Array): void;
  /** Resolves once a stop has finished flushing what was already sent (a bye). */
  whenClosed(): Promise<void>;
}
