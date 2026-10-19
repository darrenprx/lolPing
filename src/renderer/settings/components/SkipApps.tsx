import { Button, Combobox, Option } from '@fluentui/react-components';
import { Add24Regular, Apps24Regular, Camera24Regular, Dismiss24Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import type { RunningApp } from '../../../shared/ipc';
import { appNameStem, MAX_SKIP_APPS } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';

/** Process names that are lolPing itself: never offered, and a capture that never left the app adds nothing. */
const OWN_APPS = new Set(['lolping', 'electron']);

/**
 * The app-exception list: in these apps lolPing stands down entirely, so their own shortcuts (Photoshop's
 * Option + click, a Tab that toggles panels) reach them untouched. The box picks from the apps running right
 * now, with their icons where the platform has one, and still takes a typed name.
 */
export function SkipApps(props: { apps: string[]; dim: boolean; update: Update }) {
  const t = useText();
  const [name, setName] = useState('');
  const [running, setRunning] = useState<RunningApp[]>([]);
  const [countdown, setCountdown] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const refresh = (): void => {
    void api.getAppList().then((apps) => setRunning(apps.filter((a) => !OWN_APPS.has(appNameStem(a.name)))));
  };

  const add = (raw: string): void => {
    setNote(null);
    setName('');
    const stem = appNameStem(raw);
    if (stem === '' || props.apps.includes(stem) || props.apps.length >= MAX_SKIP_APPS) return;
    void props.update({ skipApps: [...props.apps, stem] });
  };

  const remove = (app: string): void => {
    setNote(null);
    void props.update({ skipApps: props.apps.filter((a) => a !== app) });
  };

  // The click itself makes lolPing frontmost, so the capture counts down: switch to the app, then it is asked for.
  const capture = async (): Promise<void> => {
    setNote(null);
    for (const s of [3, 2, 1]) {
      setCountdown(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCountdown(0);
    const front = await api.getForegroundApp();
    if (front !== null && !OWN_APPS.has(appNameStem(front))) add(front);
    else setNote(front === null ? t.skipAppsCaptureNone : t.skipAppsCaptureSelf);
  };

  return (
    <>
      <div className={`card skipApps${props.dim ? ' dim' : ''}`}>
        <div className="skipHead">
          <span className="icon"><Apps24Regular /></span>
          <div className="lbl">
            {t.skipApps}
            <span className="desc">{t.skipAppsDesc}</span>
          </div>
        </div>
        <div className="skipPick">
          <Combobox freeform placeholder={t.skipAppsPlaceholder} value={name} style={{ minWidth: 260 }}
            onChange={(e) => setName(e.target.value)}
            onOpenChange={(_, d) => { if (d.open) refresh(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') add(name); }}
            onOptionSelect={(_, d) => { if (typeof d.optionValue === 'string') add(d.optionValue); }}>
            {running.map((a) => (
              <Option key={a.name} value={a.name} text={a.name}>
                <span className="skipOpt">
                  {a.icon ? <img src={a.icon} alt="" /> : null}
                  {a.name}
                </span>
              </Option>
            ))}
          </Combobox>
          <Button icon={<Add24Regular />} onClick={() => add(name)}>{t.skipAppsAdd}</Button>
          <Button icon={<Camera24Regular />} disabled={countdown !== 0} onClick={() => void capture()}>
            {countdown !== 0 ? t.skipAppsCaptureIn(countdown) : t.skipAppsCapture}
          </Button>
        </div>
        <div className="skipList">
          {props.apps.length === 0 ? <span className="desc">{t.skipAppsEmpty}</span> : props.apps.map((a) => (
            <span key={a} className="skipChip">
              {a}
              <button onClick={() => remove(a)} aria-label={a}><Dismiss24Regular /></button>
            </span>
          ))}
        </div>
      </div>
      {note ? <div className="rowError" role="alert">{note}</div> : null}
    </>
  );
}
