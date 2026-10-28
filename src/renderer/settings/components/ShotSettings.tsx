import { Dropdown, Input, Option } from '@fluentui/react-components';
import { Image24Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import type { RoomShotSettings } from '../../../shared/roomShots';
import type { Settings } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { ExpanderRow, SettingRow, SwitchRow } from './rows';

function NumberRow(p: { title: string; value: number; min: number; max: number; step: number; save(n: number): void }) {
  const [draft, setDraft] = useState(String(p.value));
  useEffect(() => setDraft(String(p.value)), [p.value]);
  const save = (): void => {
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) p.save(Math.max(p.min, Math.min(p.max, n)));
    else setDraft(String(p.value));
  };
  return <SettingRow icon={null} title={p.title}>
    <Input type="number" aria-label={p.title} min={p.min} max={p.max} step={p.step} value={draft} style={{ width: 110 }}
      onChange={(_, d) => setDraft(d.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
  </SettingRow>;
}

export function ShotSettings({ settings: s, update }: { settings: Settings; update: Update }) {
  const { shots: t } = useText();
  if (api.platform !== 'win') return null;
  const shots = s.roomShots;
  const patch = (p: Partial<RoomShotSettings>): void => { void update({ roomShots: { ...shots, ...p } }); };
  return <>
    <SwitchRow icon={<Image24Regular />} title={t.send} description={t.description}
      checked={shots.enabled} onChange={(v) => patch({ enabled: v })} />
    <SwitchRow icon={<Image24Regular />} title={t.receive} checked={shots.receive} onChange={(v) => patch({ receive: v })} />
    <SettingRow icon={<Image24Regular />} title={t.placement}>
      <Dropdown aria-label={t.placement} value={shots.placement === 'spot' ? t.spot : t.corner} selectedOptions={[shots.placement]}
        style={{ minWidth: 170 }} onOptionSelect={(_, d) => { if (d.optionValue === 'spot' || d.optionValue === 'corner') patch({ placement: d.optionValue }); }}>
        <Option value="corner">{t.corner}</Option><Option value="spot">{t.spot}</Option>
      </Dropdown>
    </SettingRow>
    <ExpanderRow icon={<Image24Regular />} title={t.advanced}>
      <NumberRow title={t.width} value={shots.width} min={160} max={1920} step={10} save={(width) => patch({ width })} />
      <NumberRow title={t.height} value={shots.height} min={90} max={1080} step={10} save={(height) => patch({ height })} />
      <NumberRow title={t.merge} value={shots.mergeMs / 1000} min={0.3} max={3} step={0.1} save={(v) => patch({ mergeMs: v * 1000 })} />
      <NumberRow title={t.window} value={shots.windowMs / 1000} min={1} max={30} step={1} save={(v) => patch({ windowMs: v * 1000 })} />
      <NumberRow title={t.maximum} value={shots.maxMarks} min={1} max={20} step={1} save={(maxMarks) => patch({ maxMarks })} />
      <NumberRow title={t.cooldown} value={shots.cooldownMs / 1000} min={1} max={60} step={1} save={(v) => patch({ cooldownMs: v * 1000 })} />
      <NumberRow title={t.lifetime} value={shots.lifetimeMs / 1000} min={3} max={60} step={1} save={(v) => patch({ lifetimeMs: v * 1000 })} />
    </ExpanderRow>
  </>;
}
