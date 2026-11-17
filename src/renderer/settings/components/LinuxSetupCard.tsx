import { Button } from '@fluentui/react-components';
import { ShieldKeyhole24Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { api } from '../api';
import { useText } from '../text';

/** Linux only: shown while the helper has no access to the input devices (a Wayland session, before the setup). */
export function LinuxSetupCard({ command }: { command: string }) {
  const t = useText();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const setUp = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.linuxSetup();
      if (!r.ok) setError(r.detail ? `${t.linuxSetupError[r.reason]} ${r.detail}` : t.linuxSetupError[r.reason]);
    } catch {
      setError(t.linuxSetupError.failed);
    } finally {
      setRunning(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="card permission linuxSetup">
      <span className="icon"><ShieldKeyhole24Regular /></span>
      <div className="lbl">
        <b>{t.linuxSetupTitle}</b>
        <span className="desc">{t.linuxSetupBody}</span>
        <div className="actions">
          <Button appearance="primary" disabled={running} onClick={() => void setUp()}>
            {running ? t.linuxSetupRunning : t.linuxSetupButton}
          </Button>
        </div>
        {error ? <span className="rowError" role="alert">{error}</span> : null}
        <span className="desc">{t.linuxSetupManual}</span>
        <div className="actions">
          <code className="setupCommand">{command}</code>
          <Button size="small" onClick={() => void copy()}>{copied ? t.linuxSetupCopied : t.linuxSetupCopy}</Button>
        </div>
      </div>
    </div>
  );
}
