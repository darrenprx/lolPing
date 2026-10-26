import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_MEDIA, mediaConfig, normalizeRoomMedia, parseMediaSignal } from '../../src/shared/roomMedia';
import { normalizeSettings } from '../../src/shared/settings';

describe('roomMedia', () => {
  it('keeps internet animations disabled for old or malformed settings', () => {
    expect(normalizeSettings({}).roomMedia).toEqual(DEFAULT_ROOM_MEDIA);
    expect(normalizeRoomMedia({ enabled: 'true', stun: 'https://bad/', turn: 'file:///bad', username: 123 }))
      .toEqual(DEFAULT_ROOM_MEDIA);
  });

  it('accepts bounded STUN and TURN endpoints without embedded credentials', () => {
    const raw = { enabled: true, stun: 'stun:example.org:3478', turn: 'turns:example.org:5349?transport=tcp', username: 'me', relayOnly: true };
    expect(normalizeRoomMedia(raw)).toEqual(raw);
    expect(normalizeRoomMedia({ turn: 'turn:user:password@example.org' }).turn).toBe('');
    expect(normalizeRoomMedia({ stun: 'turn:example.org' }).stun).toBe(DEFAULT_ROOM_MEDIA.stun);
    expect(normalizeRoomMedia({ turn: 'stun:example.org' }).turn).toBe('');
  });

  it('keeps TURN credentials outside persisted settings and disables STUN in relay-only mode', () => {
    const settings = normalizeRoomMedia({ turn: 'turn:example.org:3478', username: 'me', relayOnly: true, password: 'secret' });
    expect(JSON.stringify(settings)).not.toContain('secret');
    expect(mediaConfig(settings, 'secret')).toEqual({
      iceServers: [{ urls: settings.turn, username: 'me', credential: 'secret' }], iceTransportPolicy: 'relay',
    });
    expect(mediaConfig(settings, null).iceServers).toEqual([]);
  });

  it('only accepts bounded data-channel offers and answers', () => {
    const signal = { id: 'a'.repeat(16), type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' };
    expect(parseMediaSignal(signal)).toEqual(signal);
    for (const patch of [{ type: 'rollback' }, { id: '../invalid' }, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP\r\n' },
      { sdp: signal.sdp + 'm=video 9 UDP/TLS/RTP\r\n' }, { sdp: signal.sdp + 'a'.repeat(30_000) }]) {
      expect(parseMediaSignal({ ...signal, ...patch })).toBeNull();
    }
  });
});
