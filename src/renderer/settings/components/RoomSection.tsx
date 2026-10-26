import { Button, Checkbox, Dropdown, Input, Option, Radio, RadioGroup, Slider, Spinner } from '@fluentui/react-components';
import {
  ArrowSync24Regular, Chat24Regular, Color24Regular, Desktop24Regular, Globe24Regular, Image24Regular, Keyboard24Regular, Person24Regular,
  PeopleCommunity24Regular, SpeakerMute24Regular, TopSpeed24Regular, Warning24Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { featureOn } from '../../../shared/features';
import type { Strings } from '../../../shared/i18n';
import { hotkeyParts, vkLabel } from '../../../shared/keys';
import type { RoomMember, RoomState } from '../../../shared/room';
import { TAG_COLORS, readableTagRgb, tagColorCss, tagHex, tagRgbFromHex } from '../../../shared/roomColors';
import { clampNameInput } from '../../../shared/roomProtocol';
import { LIMITS, type RoomTextStyle, type Settings } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { useRoomState } from '../useRoomState';
import { KeyCapture } from './KeyCapture';
import { SettingRow, SwitchRow } from './rows';
import { RoomMediaSection } from './RoomMediaSection';

const { max: LIMIT_MAX } = LIMITS.incomingPingLimit;
/** The slider runs 1…max+1; its last stop is Unlimited (stored as 0). */
const toSlider = (limit: number): number => (limit === 0 ? LIMIT_MAX + 1 : limit);
const fromSlider = (v: number): number => (v > LIMIT_MAX ? 0 : v);
const TEXT_STYLES: readonly RoomTextStyle[] = ['spot', 'danmaku'];

function NameRow({ value, onSave }: { value: string; onSave(name: string): void }) {
  const t = useText();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    if (draft !== value) onSave(draft);
  };
  return (
    <SettingRow icon={<Person24Regular />} title={t.roomName} description={t.roomNameDesc}>
      <Input value={draft} style={{ width: 190 }} onChange={(_, d) => setDraft(clampNameInput(d.value))} onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()} />
    </SettingRow>
  );
}

function JoinCard() {
  const t = useText();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const touched = useRef(false);
  useEffect(() => {
    void api.clipboardRoomCode().then((c) => {
      if (c && !touched.current) setCode(c);
    });
  }, []);
  const join = async () => {
    setBusy(true);
    const r = await api.joinRoom(code);
    setBusy(false);
    setError(r.ok ? null : r.error === 'mistyped' ? t.roomMistyped : r.error === 'failed' ? t.roomJoinFailed : t.roomInvalid);
  };
  return (
    <div className="card roomJoin">
      <span className="icon"><PeopleCommunity24Regular /></span>
      <div className="lbl">
        {t.roomJoinTitle}
        <span className="desc">{t.roomJoinDesc}</span>
        <span className="desc">{t.roomNetworkHint}</span>
      </div>
      <div className="ctl">
        <Input placeholder="PING-XXXXX-XXXXX" value={code} style={{ width: 190 }}
          onChange={(_, d) => {
            touched.current = true;
            setCode(d.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && void join()} />
        <Button appearance="primary" disabled={busy || !code.trim()} onClick={() => void join()}>{t.roomJoin}</Button>
        <Button disabled={busy} onClick={() => {
          setBusy(true); // a double click would create a room and replace it at once
          void api.createRoom().finally(() => setBusy(false));
        }}>{t.roomCreate}</Button>
      </div>
      {error ? <div className="roomError">{error}</div> : null}
    </div>
  );
}

function MemberRow({ m, room }: { m: RoomMember; room: RoomState }) {
  const t = useText();
  return (
    <div className="member">
      {!m.self && room.audience?.mode === 'selected' ? <Checkbox disabled={!m.direct}
        aria-label={m.name} checked={room.audience.peers.includes(m.peer)}
        onChange={(_, d) => void api.setRoomAudience({ mode: 'selected', peers: d.checked
          ? [...(room.audience?.peers ?? []), m.peer] : (room.audience?.peers ?? []).filter((p) => p !== m.peer) })} /> : null}
      <span className="tagDot" style={{ background: tagColorCss(m.color, m.rgb) }} />
      <span className="memberName">
        {m.name}
        {m.self ? <span className="desc inline">({t.roomYou})</span> : null}
        {m.noEmotes ? <span className="desc">{t.memberOldNoEmotes}</span> : null}
        {m.noChat ? <span className="desc">{t.memberNoChat}</span> : null}
        {m.textOff ? <span className="desc">{t.memberTextOff}</span> : null}
        {m.votesOff ? <span className="desc">{t.memberVotesOff}</span> : null}
        {!m.self && !m.direct && room.audience?.mode === 'selected' ? <span className="desc">{t.roomDirectUpgrade}</span> : null}
        {!m.self && m.media && m.media !== 'off' ? <span className="desc">{t.roomMediaStatus[m.media]}</span> : null}
      </span>
      {m.self ? null : <span className={`badge ${m.path}`}>{t.roomPath[m.path]}</span>}
      {m.status === 'paused' ? <span className="badge">{t.roomPaused}</span> : null}
      {m.status === 'muted' ? <span className="badge">{t.roomMutedBadge}</span> : null}
      {m.needsUpdate ? <span className="badge bad">{t.roomNeedsUpdate}</span> : null}
      {m.self ? null : (
        <Button size="small" appearance={m.muted ? 'primary' : 'secondary'} onClick={() => void api.muteMember(m.peer, !m.muted)}>
          {m.muted ? t.roomUnmuteMember : t.roomMuteMember}
        </Button>
      )}
    </div>
  );
}

function InRoom({ room, allowInternet }: { room: RoomState; allowInternet: boolean }) {
  const t = useText();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const alone = room.members.length <= 1;
  return (
    <>
      <div className="card">
        <span className="icon"><PeopleCommunity24Regular /></span>
        <div className="lbl">
          <span className="roomCode">{room.code}</span>
          <span className="desc">{room.phase === 'joining' ? t.roomJoining : t.roomShareDesc}</span>
        </div>
        <div className="ctl">
          {room.phase === 'joining' ? <Spinner size="tiny" /> : null}
          <Button onClick={() => {
            void api.copyRoomCode();
            setCopied(true);
          }}>{copied ? t.roomCopied : t.roomCopy}</Button>
          <Button onClick={() => void api.leaveRoom()}>{t.roomLeave}</Button>
        </div>
      </div>
      {room.lan === 'unavailable' ? (
        <div className="card permission">
          <span className="icon"><Warning24Regular /></span>
          <div className="lbl">
            <b>{t.roomLanUnavailable}</b>
            <span className="desc">{t.roomLanUnavailableDesc}</span>
          </div>
        </div>
      ) : null}
      {room.internet === 'unavailable' ? (
        <div className="card permission">
          <span className="icon"><Warning24Regular /></span>
          <div className="lbl">
            <b>{t.roomInternetUnavailable}</b>
            <span className="desc">{t.roomInternetUnavailableDesc}</span>
            <div className="actions">
              <Button onClick={() => void api.retryInternet()}>{t.roomRetry}</Button>
            </div>
          </div>
        </div>
      ) : null}
      <SettingRow className="roomAudience" icon={<PeopleCommunity24Regular />} title={t.roomAudience} description={t.roomAudienceDesc}>
        <RadioGroup layout="horizontal" value={room.audience?.mode ?? 'all'} aria-label={t.roomAudience}
          onChange={(_, d) => {
            if (d.value === 'all' || d.value === 'selected' || d.value === 'self')
              void api.setRoomAudience({ mode: d.value, peers: room.audience?.peers ?? [] });
          }}>
          <Radio value="all" label={t.roomAudienceModes.all} />
          <Radio value="selected" label={t.roomAudienceModes.selected} />
          <Radio value="self" label={t.roomAudienceModes.self} />
        </RadioGroup>
      </SettingRow>
      <div className="card members">
        {room.members.map((m) => <MemberRow key={m.peer} m={m} room={room} />)}
        {alone ? (
          <div className="desc roomWaiting">
            {room.lonely ? `${t.roomWaiting} ${t.roomLonely}` : t.roomWaiting}
            {room.lonely && !allowInternet ? <span className="warnText"> {t.roomLonelyInternetOff}</span> : null}
          </div>
        ) : null}
        {room.clockSkew ? <div className="desc roomWaiting warnText">{t.roomClockSkew}</div> : null}
      </div>
    </>
  );
}

const textStyleLabel = (t: Strings, style: RoomTextStyle): string =>
  style === 'danmaku' ? t.roomTextStyleDanmaku : t.roomTextStyleSpot;

export function RoomSection({ settings: s, update }: { settings: Settings; update: Update }) {
  const t = useText();
  const room = useRoomState();
  const [textKeyError, setTextKeyError] = useState<string | null>(null);
  const [panelKeyError, setPanelKeyError] = useState<string | null>(null);
  if (!room) return null;
  // The picker opens at the custom colour when there is one, else at the palette entry in use.
  const pickerValue = tagHex(s.tagColorCustom ?? tagRgbFromHex(TAG_COLORS[s.tagColor] ?? TAG_COLORS[0]) ?? [255, 255, 255]);
  return (
    <>
      <NameRow value={s.displayName} onSave={(displayName) => void update({ displayName })} />
      <SettingRow icon={<Color24Regular />} title={t.roomColor} description={t.roomColorCustomHint}>
        <div className="swatches">
          <div className="swatchRow" role="radiogroup" aria-label={t.roomColor}>
            {TAG_COLORS.map((c, i) => {
              const on = !s.tagColorCustom && s.tagColor === i;
              return (
                <button key={c} type="button" role="radio" aria-checked={on} aria-label={t.roomColorLabel(i + 1)}
                  className={`swatch${on ? ' sel' : ''}`} style={{ background: c }}
                  onClick={() => void update({ tagColor: i, tagColorCustom: null })} />
              );
            })}
          </div>
          <label className={`swatch custom${s.tagColorCustom ? ' sel' : ' unset'}`} title={t.roomColorCustom}
            style={s.tagColorCustom ? { background: tagColorCss(s.tagColor, s.tagColorCustom) } : undefined}>
            <input type="color" value={pickerValue} aria-label={t.roomColorCustom}
              onChange={(e) => {
                const picked = tagRgbFromHex(e.target.value);
                if (picked) void update({ tagColorCustom: readableTagRgb(picked) });
              }} />
          </label>
        </div>
      </SettingRow>
      {room.phase === 'idle' ? <JoinCard /> : <InRoom room={room} allowInternet={s.allowInternet} />}
      <SwitchRow icon={<SpeakerMute24Regular />} title={t.roomMute} description={t.roomMuteDesc}
        checked={s.roomMuted} onChange={(v) => void update({ roomMuted: v })} />
      <SettingRow icon={<TopSpeed24Regular />} title={t.roomLimit} description={t.roomLimitDesc} dim={s.roomMuted}>
        <Slider min={1} max={LIMIT_MAX + 1} step={1} value={toSlider(s.incomingPingLimit)} style={{ width: 200 }}
          onChange={(_, d) => void update({ incomingPingLimit: fromSlider(d.value) })} />
        <span className="value">{t.roomLimitValue(s.incomingPingLimit)}</span>
      </SettingRow>
      <SwitchRow icon={<Image24Regular />} title={t.friendEmotes} description={t.friendEmotesDesc}
        checked={s.friendEmotes} onChange={(v) => void update({ friendEmotes: v })} />
      <SwitchRow icon={<Globe24Regular />} title={t.roomInternet} description={t.roomInternetDesc}
        checked={s.allowInternet} onChange={(v) => void update({ allowInternet: v })} />
      <RoomMediaSection settings={s} room={room} update={update} />
      {featureOn(s, 'roomText') ? (
        <>
          <SettingRow icon={<Chat24Regular />} title={t.roomTextStyle} description={t.roomTextStyleDesc}>
            <Dropdown style={{ minWidth: 170 }} value={textStyleLabel(t, s.roomTextStyle)} selectedOptions={[s.roomTextStyle]}
              onOptionSelect={(_, d) => {
                const style = TEXT_STYLES.find((v) => v === d.optionValue);
                if (style) void update({ roomTextStyle: style });
              }}>
              {TEXT_STYLES.map((v) => <Option key={v} value={v} text={textStyleLabel(t, v)}>{textStyleLabel(t, v)}</Option>)}
            </Dropdown>
          </SettingRow>
          <SettingRow icon={<Keyboard24Regular />} title={t.textShortcut} description={t.textShortcutDesc}>
            <KeyCapture parts={hotkeyParts(s.textHotkey, api.platform)} requireModifier error={textKeyError}
              onCapture={async (c) => {
                const result = await update({ textHotkey: c });
                setTextKeyError(result.ok ? null : result.error);
              }} />
          </SettingRow>
        </>
      ) : null}
      {featureOn(s, 'roomPanel') ? (
        <SettingRow icon={<Keyboard24Regular />} title={t.panelKey}
          description={t.panelKeyDesc(vkLabel(s.panelKey, api.platform))}>
          <KeyCapture parts={[vkLabel(s.panelKey, api.platform)]} requireModifier={false} error={panelKeyError}
            onCapture={async (c) => {
              const result = await update({ panelKey: c.vk });
              setPanelKeyError(result.ok ? null : result.error);
            }} />
        </SettingRow>
      ) : null}
      <SwitchRow icon={<ArrowSync24Regular />} title={t.roomRejoin} checked={s.rejoinRoom} onChange={(v) => void update({ rejoinRoom: v })} />
      <SettingRow icon={<Desktop24Regular />} title={t.roomDisplays} description={t.roomDisplaysDesc}>
        <span className="displays">
          {room.displays.map((d) => (
            <span key={d.number}>#{d.number}{d.primary ? ` ${t.roomPrimary}` : ''} · {d.width}×{d.height}</span>
          ))}
        </span>
      </SettingRow>
      {featureOn(s, 'teammate') && s.teammate.askTrigger === 'same' ? (
        <p className="desc roomNote warnText">{t.teammate.settings.askKeySameNote}</p>
      ) : null}
      <p className="desc roomNote">{t.roomPrivacy} {t.roomHelp}</p>
    </>
  );
}
