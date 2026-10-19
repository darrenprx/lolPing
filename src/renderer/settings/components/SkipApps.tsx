import { Button, Combobox, Option } from '@fluentui/react-components';
import { Add24Regular, Apps24Regular, Camera24Regular, Dismiss24Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { appNameStem, MAX_SKIP_APPS } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';

/** Process names that are lolPing itself, so neither the dropdown nor a capture offers or adds it. */
const OWN_APPS = new Set(['lolping', 'electron']);

/**
 * The app-exception list: in these apps lolPing stands down entirely, so their own shortcuts
 * (Photoshop's Option + click colour picker, a Tab that toggles panels) reach them untouched.
 * The box both picks from the apps running right now and accepts a name by hand.
 */
export function SkipApps(props: { apps: string[]; dim: boolean; update: Update }) {
  const t = useText();
  const [name, setName] = useState('');
  const [running, setRunning] = useState<string[]>([]);
  const [countdown, setCountdown] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const refresh = (): void => {
    void api.getAppList().then((names) => {
      if (live.current) setRunning(names.filter((n) => !OWN_APPS.has(appNameStem(n))));
    });
  };
  useEffect(refresh, []);

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
      if (!live.current) return;
    }
    setCountdown(0);
    const got = await api.getForegroundApp();
    if (!live.current) return;
    if (got === null) setNote(t.skipAppsCaptureNone);
    else if (OWN_APPS.has(appNameStem(got))) setNote(t.skipAppsCaptureSelf);
    else add(got);
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
          <div className="skipControls">
            <Combobox freeform placeholder={t.skipAppsPlaceholder} value={name} style={{ minWidth: 200 }}
              onChange={(e) => setName(e.target.value)}
              onOpenChange={(_, d) => { if (d.open) refresh(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') add(name); }}
              onOptionSelect={(_, d) => { if (typeof d.optionValue === 'string') add(d.optionValue); }}>
              {running.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Combobox>
            <Button icon={<Add24Regular />} onClick={() => add(name)}>{t.skipAppsAdd}</Button>
            <Button icon={<Camera24Regular />} disabled={countdown !== 0} onClick={() => void capture()}>
              {countdown !== 0 ? t.skipAppsCaptureIn(countdown) : t.skipAppsCapture}
            </Button>
          </div>
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
