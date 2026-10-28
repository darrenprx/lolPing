import { Button, Switch } from '@fluentui/react-components';
import type { AppStatus } from '../../../shared/ipc';
import { hotkeyLabel } from '../../../shared/keys';
import { LOGO_TEXTURE, textureUrl } from '../../../shared/pings';
import { triggerLabel, type Settings } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';

export function StatusCard({ settings, status }: { settings: Settings; status: AppStatus }) {
  const t = useText();
  const failed = status.helper === 'failed';
  const noAccess = status.helper === 'noAccess';
  const dot = failed || noAccess ? ' failed' : status.enabled ? '' : ' off';
  const title = failed ? t.statusHelperStopped : noAccess ? t.statusNoAccess : status.enabled ? t.statusOn : t.statusOff;
  const hint = failed
    ? t.statusFailedHint
    : noAccess
      ? t.statusNoAccessHint
      : t.statusHint(triggerLabel(settings.trigger, t.lang, api.platform), hotkeyLabel(settings.toggleHotkey, api.platform), status.enabled);
  return (
    <div className="card status">
      {/* Keyed by state, so the dot pops again when lolPing turns on, off or fails. */}
      <div key={dot} className={`dot${dot}`} />
      <img className="statusPing" src={textureUrl(LOGO_TEXTURE)} alt="" />
      <div className="lbl">
        <b style={{ fontSize: 16 }}>{title}</b>
        <span className="desc">{hint}</span>
        {status.markerCooldownMs ? <span className="desc">{t.shots.wait(Math.ceil(status.markerCooldownMs / 1000))}</span> : null}
      </div>
      <div className="ctl">
        {noAccess && api.platform === 'mac' ? null : failed || noAccess ? (
          <Button appearance="primary" onClick={() => void api.retryHelper()}>{t.restartHelper}</Button>
        ) : (
          <Switch checked={status.enabled} onChange={(_, d) => void api.setEnabled(d.checked)} label={status.enabled ? t.on : t.off} labelPosition="before" />
        )}
      </div>
    </div>
  );
}
