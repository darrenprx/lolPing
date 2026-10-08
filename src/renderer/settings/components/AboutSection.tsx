import { Button, ProgressBar } from '@fluentui/react-components';
import { ArrowDownload24Regular, ArrowSync24Regular, ErrorCircle24Regular } from '@fluentui/react-icons';
import { useEffect, useState, type ReactNode } from 'react';
import type { About } from '../../../shared/ipc';
import type { UpdateState } from '../../../shared/update';
import { api } from '../api';
import { useText } from '../text';
import { checkNote, formatCheckTime } from '../updateView';
import { SettingRow } from './rows';

const MAC = api.platform === 'mac';

/**
 * `update`: the update checker's state, or null when this build has none (a development build), which hides every
 * update control. The state is read once by the page, which also shows the automatic-check switch.
 */
export function AboutSection({ icon, update }: { icon: ReactNode; update: UpdateState | null }) {
  const t = useText();
  const [about, setAbout] = useState<About | null>(null);
  // Limitations and problems come translated from the main process: re-read them when the language changes.
  useEffect(() => {
    void api.getAbout().then(setAbout);
  }, [t]);
  if (!about) return null;
  const note = update ? checkNote(update, t, (ms) => formatCheckTime(ms, t.lang)) : null;
  return (
    <>
      <SettingRow icon={icon} title={t.about}
        description={(
          <>
            {t.aboutDesc(about.version)}
            {note ? <span className="desc">{note}</span> : null}
          </>
        )}>
        {update ? (
          <Button disabled={update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'installing'}
            onClick={() => void api.checkForUpdates()}>
            {update.phase === 'checking' ? t.checking : t.checkForUpdates}
          </Button>
        ) : null}
        <Button onClick={() => void api.openProjectPage()}>{t.githubPage}</Button>
        <Button onClick={() => void api.openSettingsFolder()}>{t.openSettingsFolder}</Button>
      </SettingRow>
      {update ? <UpdateCard update={update} /> : null}
      {about.problems.length > 0 ? (
        <div className="card notes">
          <div className="lbl">
            <b>{t.problems}</b>
            {about.problems.map((p) => <span key={p} className="desc">• {p}</span>)}
          </div>
        </div>
      ) : null}
      <div className="card notes">
        <div className="lbl">
          <b>{t.knownLimitations}</b>
          {about.limitations.map((l) => <span key={l} className="desc">• {l}</span>)}
        </div>
      </div>
    </>
  );
}

/** The card under the version row for the part of an update that needs the user's eyes: the offer, the progress, the failure. */
function UpdateCard({ update }: { update: UpdateState }) {
  const t = useText();
  if (update.phase === 'available') {
    return (
      <div className="card update">
        <span className="icon"><ArrowDownload24Regular /></span>
        <div className="lbl">
          <b>{t.updateAvailable(update.version)}</b>
          {MAC ? <span className="desc">{t.updateMacSteps}</span> : null}
        </div>
        <div className="ctl">
          <Button appearance="primary" onClick={() => void api.startUpdate()}>{t.updateNow}</Button>
          <Button onClick={() => void api.openReleasePage()}>{t.whatsNew}</Button>
        </div>
      </div>
    );
  }
  if (update.phase === 'downloading') {
    return (
      <div className="card update">
        <span className="icon"><ArrowDownload24Regular /></span>
        <div className="lbl">
          <b>{t.downloadingUpdate(update.percent)}</b>
          <ProgressBar className="updateBar" value={update.percent} max={100} aria-label={t.downloadingUpdate(update.percent)} />
        </div>
      </div>
    );
  }
  if (update.phase === 'installing') {
    return (
      <div className="card update">
        <span className="icon"><ArrowSync24Regular /></span>
        <div className="lbl">
          <b>{t.installingUpdate}</b>
          <ProgressBar className="updateBar" aria-label={t.installingUpdate} />
        </div>
      </div>
    );
  }
  if (update.phase === 'error') {
    const retry = update.retry === 'check' ? () => void api.checkForUpdates() : () => void api.startUpdate();
    return (
      <div className="card update failed" role="alert">
        <span className="icon"><ErrorCircle24Regular /></span>
        <div className="lbl">
          <span className="warnText">{update.message}</span>
        </div>
        <div className="ctl">
          <Button appearance="primary" onClick={retry}>{t.retry}</Button>
          {update.retry === 'download' ? <Button onClick={() => void api.openReleasePage()}>{t.whatsNew}</Button> : null}
        </div>
      </div>
    );
  }
  return null;
}
