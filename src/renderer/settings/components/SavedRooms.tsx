import { Button, Input, Spinner } from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular, PeopleCommunity24Regular } from '@fluentui/react-icons';
import { useRef, useState } from 'react';
import type { RoomState } from '../../../shared/room';
import { formatRoomCode } from '../../../shared/roomCode';
import { ROOM_LABEL_MAX, SAVED_ROOMS_MAX, type SavedRoom, type SavedRoomEdit } from '../../../shared/savedRooms';
import { api } from '../api';
import { useText } from '../text';

/** Settings pushes keep this list in sync with joins made through the tray or on startup. */
export function SavedRooms({ rooms, room }: { rooms: readonly SavedRoom[]; room: RoomState }) {
  const t = useText();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const blocked = Boolean(busy) || room.phase === 'joining';
  const run = async (code: string, work: () => Promise<void>) => {
    if (lock.current || room.phase === 'joining') return;
    lock.current = true;
    setBusy(code);
    setError(null);
    try { await work(); }
    catch { setError(t.roomList.error); }
    finally { lock.current = false; setBusy(null); }
  };
  const edit = (op: SavedRoomEdit) => run(op.code, async () => {
    if (!await api.editSavedRoom(op)) { setError(t.roomList.error); return; }
    setEditing(null);
  });
  const join = (code: string) => run(code, async () => {
    const result = await api.joinRoom(formatRoomCode(code));
    if (!result.ok) setError(result.error === 'mistyped' ? t.roomMistyped
      : result.error === 'invalid' ? t.roomInvalid : t.roomJoinFailed);
  });
  return <section className="card savedRooms" aria-label={t.roomList.title}>
    <div className="savedRoomsHead">
      <span className="icon"><PeopleCommunity24Regular /></span>
      <div className="lbl">{t.roomList.title}<span className="desc">{t.roomList.description}</span></div>
      <span className="badge">{rooms.length} / {SAVED_ROOMS_MAX}</span>
    </div>
    {rooms.length === 0 ? <p className="desc savedRoomsEmpty">{t.roomList.empty}</p> :
      <ul className="savedRoomsList">{rooms.map((entry) => {
        const code = formatRoomCode(entry.code), current = room.code === code;
        const name = entry.label || code;
        const time = entry.joinedAt > 0 ? new Date(entry.joinedAt).toLocaleString(undefined,
          { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        return <li key={entry.code} data-code={entry.code} className={`savedRoom${current ? ' current' : ''}`}>
          {editing === entry.code ? <div className="savedRoomEditor">
            <Input autoFocus value={draft} placeholder={t.roomList.name} aria-label={t.roomList.name}
              disabled={blocked} onChange={(_, data) => setDraft(Array.from(data.value).slice(0, ROOM_LABEL_MAX).join(''))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void edit({ action: 'rename', code: entry.code, label: draft }); }
                else if (event.key === 'Escape' && !blocked) setEditing(null);
              }} />
            <Button size="small" appearance="primary" disabled={blocked} data-action="save"
              onClick={() => void edit({ action: 'rename', code: entry.code, label: draft })}>{t.roomList.save}</Button>
            <Button size="small" disabled={blocked} onClick={() => setEditing(null)}>{t.roomList.cancel}</Button>
          </div> : <>
            <div className="savedRoomLabel"><span className="savedRoomName" title={name}>{name}</span>
              <span className="desc savedRoomMeta">{entry.label ? <code>{code}</code> : null}
                <span>{time ? t.roomList.lastJoined(time) : t.roomList.saved}</span></span>
            </div>
            <div className="savedRoomActions">
              {current ? <span className="badge">{room.phase === 'joining' ? t.roomJoining : t.roomList.current}</span> : null}
              {busy === entry.code ? <Spinner size="tiny" /> : null}
              <Button size="small" appearance={current ? 'secondary' : 'primary'} disabled={blocked || current}
                data-action="join" onClick={() => void join(entry.code)}>
                {current ? t.roomJoin : room.phase === 'idle' ? t.roomJoin : t.roomList.switch}
              </Button>
              <Button size="small" appearance="subtle" icon={<Edit24Regular />} disabled={blocked}
                data-action="rename" aria-label={`${t.roomList.rename} ${name}`} title={t.roomList.rename}
                onClick={() => { setEditing(entry.code); setDraft(entry.label); setError(null); }} />
              <Button size="small" appearance="subtle" icon={<Delete24Regular />} disabled={blocked}
                data-action="forget" aria-label={`${t.roomList.forget} ${name}`} title={t.roomList.forget}
                onClick={() => void edit({ action: 'forget', code: entry.code })} />
            </div>
          </>}
        </li>;
      })}</ul>}
    {error ? <div className="roomError" role="alert">{error}</div> : null}
  </section>;
}
