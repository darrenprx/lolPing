import type { Strings } from '../shared/i18n';
import type { PingTag } from '../shared/ipc';
import type { MemberTag, RemoteText, RoomManager } from './roomManager';
import type { HistoryLine } from '../shared/roomHistory';
import type { RoomHistory } from './roomHistory';

export interface RoomTextDeps {
  room: Pick<RoomManager, 'on' | 'off' | 'state'>;
  /** Draws a line on the overlay of display `displayId`; the caller adds the text style. */
  show(p: { displayId: number; x: number; y: number; text: string; owner: string; tag?: PingTag }): void;
  history: RoomHistory;
  text(): Strings;
  now(): number;
}

export interface RoomLine {
  kind: HistoryLine['kind'];
  /** 'self', 'vote' or the member's peer ID: the overlay keeps at most 3 lines per owner. */
  owner: string;
  /** Null for a vote result: nobody said it. */
  tag: MemberTag | null;
  displayId: number;
  x: number;
  y: number;
  text: string;
}

/** Keeps a line in history and optionally shows it on the desktop; chat sends need no extra bubble. */
export function postLine(
  deps: Pick<RoomTextDeps, 'show' | 'history' | 'now'>, line: RoomLine, options: { overlay?: boolean } = {},
): void {
  const { kind, tag, text } = line;
  if (options.overlay !== false) {
    deps.show({ displayId: line.displayId, x: line.x, y: line.y, text, owner: line.owner, ...(tag ? { tag } : {}) });
  }
  deps.history.push({ at: deps.now(), kind, tag: tag && { name: tag.name, color: tag.color, rgb: tag.rgb }, text });
}

/** Draws the text and alive lines other members send. Returns a function that stops it. */
export function startRoomText(deps: RoomTextDeps): () => void {
  const onText = (p: RemoteText): void => {
    const common = { owner: p.peer, tag: p.tag, displayId: p.displayId, x: p.x, y: p.y };
    if (p.kind === 'text') {
      if (p.text !== undefined) postLine(deps, { ...common, kind: 'text', text: p.text }, { overlay: p.overlay });
      return;
    }
    // The line is written here, in our language, with the name of the member they clicked.
    const who = deps.room.state().members.find((m) => m.peer === p.who);
    if (who) postLine(deps, { ...common, kind: 'alive', text: deps.text().aliveLine(who.name) });
  };
  deps.room.on('remoteText', onText);
  return () => {
    deps.room.off('remoteText', onText);
  };
}
