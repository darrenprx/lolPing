import { Button, Input } from '@fluentui/react-components';
import { ArrowSync24Regular, Delete24Regular, Globe24Regular, LockClosed24Regular, Save24Regular, Server24Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import type { RoomState } from '../../../shared/room';
import { normalizeRoomMedia } from '../../../shared/roomMedia';
import type { Settings } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SettingRow, SwitchRow } from './rows';

function ServerRow({ field, title, value, save }: {
  field: 'stun' | 'turn'; title: string; value: string; save(value: string): void;
}) {
  const t = useText();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const clean = draft.trim();
    if (normalizeRoomMedia({ [field]: clean })[field] !== clean) { setError(true); return; }
    setError(false);
    if (clean !== value) save(clean);
  };
  return <SettingRow className="roomMediaField" icon={<Server24Regular />} title={title} description={error ? t.roomMediaServerInvalid : undefined}>
    <Input aria-label={title} value={draft}
      onChange={(_, d) => { setDraft(d.value); setError(false); }} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
  </SettingRow>;
}

export function RoomMediaSection({ settings: s, room, update }: { settings: Settings; room: RoomState; update: Update }) {
  const t = useText();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const patch = (value: Partial<Settings['roomMedia']>) => void update({ roomMedia: { ...s.roomMedia, ...value } });
  const save = async (value: string) => {
    setBusy(true);
    try {
      const ok = await api.setRoomTurnCredential(value);
      setError(!ok);
      if (ok) setPassword('');
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <>
    <SwitchRow icon={<Globe24Regular />} title={t.roomMediaTitle} description={t.roomMediaPrivacy}
      checked={s.roomMedia.enabled} onChange={(enabled) => patch({ enabled })} />
    {s.roomMedia.enabled ? <>
      <ServerRow field="stun" title={t.roomStun} value={s.roomMedia.stun} save={(stun) => patch({ stun })} />
      <ServerRow field="turn" title={t.roomTurn} value={s.roomMedia.turn} save={(turn) => patch({ turn })} />
      <SettingRow className="roomMediaField" icon={<Server24Regular />} title={t.roomTurnUser}>
        <Input aria-label={t.roomTurnUser} value={s.roomMedia.username} maxLength={256}
          onChange={(_, d) => patch({ username: d.value })} />
      </SettingRow>
      <SettingRow className="roomMediaField" icon={<LockClosed24Regular />} title={t.roomTurnPassword}
        description={!room.mediaSecretsAvailable ? t.roomTurnUnavailable : error ? t.roomTurnError : room.turnConfigured ? t.roomTurnSaved : t.roomTurnEmpty}>
        <Input aria-label={t.roomTurnPassword} type="password" value={password} maxLength={4096} autoComplete="new-password"
          disabled={busy || !room.mediaSecretsAvailable} onChange={(_, d) => setPassword(d.value)} />
        <Button icon={<Save24Regular />} aria-label={t.roomTurnSave} title={t.roomTurnSave}
          disabled={busy || !password || !room.mediaSecretsAvailable} onClick={() => void save(password)} />
        <Button icon={<Delete24Regular />} aria-label={t.roomTurnClear} title={t.roomTurnClear}
          disabled={busy || !room.turnConfigured} onClick={() => void save('')} />
      </SettingRow>
      <SwitchRow icon={<LockClosed24Regular />} title={t.roomRelayOnly} description={t.roomRelayOnlyDesc}
        checked={s.roomMedia.relayOnly} onChange={(relayOnly) => patch({ relayOnly })} />
      <SettingRow icon={<ArrowSync24Regular />} title={t.roomMediaRetry}>
        <Button icon={<ArrowSync24Regular />} aria-label={t.roomMediaRetry} title={t.roomMediaRetry}
          onClick={() => void api.retryRoomMedia()} />
      </SettingRow>
    </> : null}
  </>;
}
