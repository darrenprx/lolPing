import { Button, Combobox, Option } from '@fluentui/react-components';
import { Add24Regular, Camera24Regular, Dismiss12Regular, FilterDismiss24Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import type { RunningApp } from '../../../shared/ipc';
import { appNameStem, MAX_SKIP_APPS, resolveSkipApp } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';

/** Process names that are lolPing itself: never offered, and a capture that never left the app adds nothing. */
const isOwnApp = (name: string): boolean => {
  const stem = appNameStem(name).toLowerCase();
  return stem === 'lolping' || stem === 'electron';
};

/**
 * The app-exception list: in these apps lolPing stands down entirely, so their own shortcuts (Photoshop's
 * Option + click, a Tab that toggles panels) reach them untouched. The box picks from the apps running right
 * now, with their icons where the platform has one, and still takes a typed name.
 */
export function SkipApps(props: { apps: string[]; dim: boolean; update: Update }) {
  const t = useText();
  const [name, setName] = useState('');
  const [running, setRunning] = useState<RunningApp[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const refresh = (): void => {
    void api.getAppList().then((apps) => setRunning(apps.filter((a) => !isOwnApp(a.name))));
  };

  const add = (raw: string): void => {
    setNote(null);
    setName('');
    // A typed name may be the words the system shows for an app (an IME offers those); store the process name then.
    const stem = resolveSkipApp(raw, running);
    if (stem === '' || props.apps.includes(stem) || props.apps.length >= MAX_SKIP_APPS) return;
    void props.update({ skipApps: [...props.apps, stem] });
  };

  const remove = (app: string): void => {
    setNote(null);
    void props.update({ skipApps: props.apps.filter((a) => a !== app) });
  };

  // The window hides for the wait, so the app the user wants is simply the one left in front.
  const capture = async (): Promise<void> => {
    setNote(null);
    const front = await api.captureForegroundApp();
    if (front !== null && !isOwnApp(front)) add(front);
    else setNote(front === null ? t.skipAppsCaptureNone : t.skipAppsCaptureSelf);
  };

  return (
    <>
      <div className={`card skipApps${props.dim ? ' dim' : ''}`}>
        <div className="skipHead">
          <span className="icon"><FilterDismiss24Regular /></span>
          <div className="lbl">
            {t.skipApps}
            <span className="desc">{t.skipAppsDesc}</span>
          </div>
        </div>
        <div className="skipPick">
          <Combobox freeform placeholder={t.skipAppsPlaceholder} value={name} selectedOptions={[]} style={{ minWidth: 260 }}
            onChange={(e) => setName(e.target.value)}
            onOpenChange={(_, d) => { if (d.open) refresh(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') add(name); }}
            onOptionSelect={(_, d) => { if (typeof d.optionValue === 'string') add(d.optionValue); }}>
            {running.map((a) => {
              const shown = a.desc && a.desc !== a.name ? a.desc : a.name;
              return (
                <Option key={a.name} value={a.name} text={shown}>
                  <span className="skipOpt">
                    <span className="skipOptIco">
                      {a.icon ? <img src={a.icon} alt="" /> : <span className="skipDot">{a.name.slice(0, 1).toUpperCase()}</span>}
                    </span>
                    {shown}
                  </span>
                </Option>
              );
            })}
          </Combobox>
          <Button icon={<Add24Regular />} onClick={() => add(name)}>{t.skipAppsAdd}</Button>
          <Button icon={<Camera24Regular />} onClick={() => void capture()}>{t.skipAppsCapture}</Button>
        </div>
        <div className="skipList">
          {props.apps.length === 0 ? <span className="desc">{t.skipAppsEmpty}</span> : props.apps.map((a) => (
            <span key={a} className="skipChip">
              {a}
              <button onClick={() => remove(a)} aria-label={a}><Dismiss12Regular /></button>
            </span>
          ))}
        </div>
      </div>
      {note ? <div className="rowError" role="alert">{note}</div> : null}
    </>
  );
}
