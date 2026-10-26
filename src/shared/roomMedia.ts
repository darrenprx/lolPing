export interface RoomMediaSettings {
  enabled: boolean;
  stun: string;
  turn: string;
  username: string;
  relayOnly: boolean;
}

export const DEFAULT_ROOM_MEDIA: RoomMediaSettings = {
  enabled: false,
  stun: 'stun:stun.l.google.com:19302',
  turn: '',
  username: '',
  relayOnly: false,
};

export const MEDIA_CH = { command: 'room-media:command', event: 'room-media:event' } as const;
export type MediaStatus = 'off' | 'connecting' | 'connected' | 'failed';
export interface MediaConfig {
  iceServers: { urls: string; username?: string; credential?: string }[];
  iceTransportPolicy: 'all' | 'relay';
}

export interface MediaSignal {
  id: string;
  type: 'offer' | 'answer';
  sdp: string;
}

export type MediaCommand =
  | { t: 'reset'; self: string; config: MediaConfig }
  | { t: 'peers'; peers: string[] }
  | { t: 'signal'; peer: string; signal: MediaSignal }
  | { t: 'packet'; peer: string; bytes: Uint8Array };

export type MediaEvent =
  | { t: 'ready' }
  | { t: 'signal'; peer: string; signal: MediaSignal }
  | { t: 'status'; peer: string; status: MediaStatus }
  | { t: 'packet'; peer: string; bytes: Uint8Array };

export interface MediaApi {
  on(cb: (command: MediaCommand) => void): () => void;
  emit(event: MediaEvent): void;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const URL_RE = /^(stun|turn|turns):(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/i;

export function normalizeRoomMedia(raw: unknown): RoomMediaSettings {
  const r = object(raw) ? raw : {};
  const url = (v: unknown, kind: 'stun' | 'turn', fallback: string): string => {
    if (v === '') return '';
    const prefix = kind === 'turn' ? /^turns?:/ : /^stun:/;
    return typeof v === 'string' && v.length <= 256 && URL_RE.test(v) && prefix.test(v)
      ? v : fallback;
  };
  return {
    enabled: r.enabled === true,
    stun: url(r.stun, 'stun', DEFAULT_ROOM_MEDIA.stun),
    turn: url(r.turn, 'turn', ''),
    username: typeof r.username === 'string' ? r.username.slice(0, 256) : '',
    relayOnly: r.relayOnly === true,
  };
}

/** Only bounded offer/answer descriptions, never arbitrary browser configuration from a room member. */
export function parseMediaSignal(raw: unknown): MediaSignal | null {
  if (!object(raw) || typeof raw.id !== 'string' || !/^[0-9a-f]{16}$/.test(raw.id)) return null;
  if (raw.type !== 'offer' && raw.type !== 'answer') return null;
  if (typeof raw.sdp !== 'string' || raw.sdp.length > 30_000 || !raw.sdp.startsWith('v=0\r\n')) return null;
  if (!raw.sdp.includes('m=application ') || /(?:^|\r\n)m=(?:audio|video) /.test(raw.sdp)) return null;
  return { id: raw.id, type: raw.type, sdp: raw.sdp };
}

/** ICE credentials stay on this computer and are never included in room signalling. */
export function mediaConfig(settings: RoomMediaSettings, credential: string | null): MediaConfig {
  const iceServers: MediaConfig['iceServers'] = [];
  if (settings.stun && !settings.relayOnly) iceServers.push({ urls: settings.stun });
  if (settings.turn && credential) {
    iceServers.push({ urls: settings.turn, username: settings.username, credential });
  }
  return { iceServers, iceTransportPolicy: settings.relayOnly ? 'relay' : 'all' };
}
