import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RoomHistory } from '../../src/main/roomHistory';
import { postLine, startRoomText, type RoomTextDeps } from '../../src/main/roomText';
import type { RemoteText } from '../../src/main/roomManager';
import { strings } from '../../src/shared/i18n';
import type { RoomMember } from '../../src/shared/room';

type Shown = Parameters<RoomTextDeps['show']>[0];

const member = (peer: string, name: string, self = false): RoomMember => ({
  peer, name, color: 2, rgb: null, path: 'lan', status: 'on', needsUpdate: false, noEmotes: false, noChat: false,
  textOff: false, votesOff: false, muted: false, self,
});

/** A room that only has members and events, which is all the text unit looks at. */
class FakeRoom extends EventEmitter {
  members = [member('me', 'Sam', true), member('alex', 'Alex'), member('kim', 'Kim')];
  state(): { members: RoomMember[] } {
    return { members: this.members };
  }
}

function setup(lang: 'en' | 'zh-CN' = 'en') {
  const room = new FakeRoom();
  const history = new RoomHistory();
  const shown: Shown[] = [];
  const deps: RoomTextDeps = {
    room: room as unknown as RoomTextDeps['room'],
    show: (p) => shown.push(p),
    history,
    text: () => strings(lang),
    now: () => 1234,
  };
  return { room, history, shown, deps, stop: startRoomText(deps) };
}

const spoken = (over: Partial<RemoteText>): RemoteText => ({
  kind: 'text', peer: 'alex', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] }, displayId: 7, x: 100, y: 50, text: 'push mid', ...over,
});

describe('startRoomText', () => {
  it('shows a member\'s text under their tag and keeps it in the history', () => {
    const { room, shown, history } = setup();
    room.emit('remoteText', spoken({}));
    expect(shown).toEqual([
      { displayId: 7, x: 100, y: 50, text: 'push mid', owner: 'alex', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] } },
    ]);
    expect(history.lines()).toEqual([
      { at: 1234, kind: 'text', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] }, text: 'push mid' },
    ]);
  });

  it('keeps a friend\'s chat message in history without showing a desktop bubble', () => {
    const { room, shown, history } = setup();
    room.emit('remoteText', spoken({ overlay: false }));
    expect(shown).toEqual([]);
    expect(history.lines()).toEqual([
      { at: 1234, kind: 'text', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] }, text: 'push mid' },
    ]);
  });

  it('writes an alive line with the clicked member\'s name under the clicker\'s tag', () => {
    const { room, shown, history } = setup();
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'kim' }));
    expect(shown).toHaveLength(1);
    expect(shown[0].text).toBe('Kim - Alive');
    expect(shown[0].tag?.name).toBe('Alex');
    expect(history.lines()[0]).toMatchObject({ kind: 'alive', text: 'Kim - Alive', tag: { name: 'Alex' } });
  });

  it('writes the alive line in our own language', () => {
    const { room, shown } = setup('zh-CN');
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'kim' }));
    expect(shown[0].text).toBe('Kim - 存活');
  });

  it('shows our own name when the clicked member is us', () => {
    const { room, shown } = setup();
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'me' }));
    expect(shown[0].text).toBe('Sam - Alive');
  });

  it('drops an alive line for a member we do not know', () => {
    const { room, shown, history } = setup();
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'stranger' }));
    expect(shown).toEqual([]);
    expect(history.lines()).toEqual([]);
  });

  it('ignores a text event that carries no text', () => {
    const { room, shown } = setup();
    room.emit('remoteText', spoken({ text: undefined }));
    expect(shown).toEqual([]);
  });

  it('stops listening when stopped', () => {
    const { room, shown, history, stop } = setup();
    stop();
    room.emit('remoteText', spoken({}));
    expect(shown).toEqual([]);
    expect(history.lines()).toEqual([]);
    expect(room.listenerCount('remoteText')).toBe(0);
  });
});

describe('postLine', () => {
  it('shows our own line and keeps it in the history, like a member\'s', () => {
    const { deps, shown, history } = setup();
    postLine(deps, {
      kind: 'text', owner: 'self', tag: { name: 'Sam', color: 0, rgb: null }, displayId: 3, x: 5, y: 6, text: 'gg',
    });
    expect(shown).toEqual([{ displayId: 3, x: 5, y: 6, text: 'gg', owner: 'self', tag: { name: 'Sam', color: 0, rgb: null } }]);
    expect(history.lines()).toEqual([{ at: 1234, kind: 'text', tag: { name: 'Sam', color: 0, rgb: null }, text: 'gg' }]);
  });

  it('keeps a chat send in history without spawning a desktop bubble', () => {
    const { deps, shown, history } = setup();
    postLine(deps, {
      kind: 'text', owner: 'self', tag: { name: 'Sam', color: 0, rgb: null }, displayId: 3, x: 5, y: 6, text: 'gg',
    }, { overlay: false });
    expect(shown).toEqual([]);
    expect(history.lines()).toEqual([{ at: 1234, kind: 'text', tag: { name: 'Sam', color: 0, rgb: null }, text: 'gg' }]);
  });

  it('shows a vote result with no name tag and keeps it in the history', () => {
    const { deps, shown, history } = setup();
    postLine(deps, { kind: 'vote', owner: 'vote', tag: null, displayId: 3, x: 5, y: 6, text: 'Everyone is ready' });
    expect(shown).toEqual([{ displayId: 3, x: 5, y: 6, text: 'Everyone is ready', owner: 'vote' }]);
    expect(history.lines()).toEqual([{ at: 1234, kind: 'vote', tag: null, text: 'Everyone is ready' }]);
  });
});
