import { Button, Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components';
import { Sparkle24Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import type { AiConnectionConfig } from '../../../shared/aiConfig';
import { ALL_PINGS, textureUrl, type PingId } from '../../../shared/pings';
import type { AiSignalAction, AiSignalConfig, Settings } from '../../../shared/settings';
import { api } from '../api';
import type { Update } from '../useAppState';
import { useText } from '../text';

const ACTIONS: AiSignalAction[] = ['off', 'show', 'copy', 'showAndCopy'];

export function AiAssistSection({ settings, update }: { settings: Settings; update: Update }) {
  const t = useText();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<AiConnectionConfig | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void api.getAiConfig().then((value) => {
      setConfig(value); setEndpoint(value.endpoint); setModel(value.model);
    }).catch(() => { setFailed(true); setMessage(t.aiSaveError); });
  }, [t.aiSaveError]);
  const save = async (clearApiKey = false) => {
    setBusy(true); setMessage('');
    try {
      const result = await api.saveAiConfig({ endpoint, model, ...(key.trim() ? { apiKey: key.trim() } : {}), clearApiKey });
      setFailed(!result.ok);
      if (result.ok) { setConfig(result.config); setKey(''); setMessage(t.aiSaved); }
      else setMessage(result.error === 'invalid' ? t.aiInvalidConfig : t.aiSaveError);
    } catch { setFailed(true); setMessage(t.aiSaveError); }
    finally { setBusy(false); }
  };
  const actionLabel = (action: AiSignalAction): string => ({ off: t.aiOff, show: t.aiShow, copy: t.aiCopy, showAndCopy: t.aiShowAndCopy }[action]);
  const change = (id: PingId, patch: Partial<AiSignalConfig>) => {
    void update({ aiSignals: { ...settings.aiSignals, [id]: { ...settings.aiSignals[id], ...patch } } });
  };
  return (
    <>
      <div className="card aiEditor aiConnection">
        <div className="aiHead"><Sparkle24Regular className="icon" /><div className="lbl"><b>{t.aiConnection}</b><span className="desc">{t.aiKeyHelp}</span></div></div>
        <div className="aiConnectionFields">
          <Field label={t.aiEndpoint} className="aiEndpoint"><Input value={endpoint} disabled={!config || busy} onChange={(_, data) => setEndpoint(data.value)} placeholder="https://api.deepseek.com/chat/completions" /></Field>
          <Field label={t.aiModel}><Input value={model} disabled={!config || busy} onChange={(_, data) => setModel(data.value)} placeholder="deepseek-flash" /></Field>
          <Field label="API Key"><Input type="password" autoComplete="off" value={key} disabled={!config || busy} onChange={(_, data) => setKey(data.value)} placeholder={config?.hasApiKey ? t.aiKeyReplace : t.aiKeyEnter} /></Field>
        </div>
        <div className="aiConnectionActions">
          <span className={`desc${config?.hasApiKey ? '' : ' warnText'}`}>{config?.hasApiKey ? t.aiKeyConfigured : t.aiNotConfigured}</span>
          <Button appearance="primary" disabled={!config || busy || !endpoint.trim() || !model.trim()} onClick={() => void save()}>{busy ? t.aiSaving : t.aiSave}</Button>
          <Button disabled={!config?.hasApiKey || busy} onClick={() => void save(true)}>{t.aiClearKey}</Button>
        </div>
        {config && !config.encryptionAvailable ? <span className="desc warnText">{t.aiEncryptionUnavailable}</span> : null}
        {message ? <div className={`aiFeedback${failed ? ' warnText' : ''}`} role={failed ? 'alert' : 'status'}>{message}</div> : null}
      </div>
      <div className="card aiEditor">
        <div className="aiHead"><div className="lbl"><b>{t.aiSignalsTitle}</b><span className="desc">{t.aiDesc}</span></div></div>
        {ALL_PINGS.map((p) => {
          const config = settings.aiSignals[p.id];
          const prompt = drafts[p.id] ?? config.prompt;
          return (
            <div className="aiRow" key={p.id}>
              <div className="aiSignalHeader">
                <div className="aiName"><img src={textureUrl(p.icon)} alt="" /><b>{t.pingNames[p.id]}</b></div>
                <Dropdown aria-label={`${t.pingNames[p.id]} ${t.aiAction}`} style={{ minWidth: 0, width: '100%' }} value={actionLabel(config.action)} selectedOptions={[config.action]}
                  onOptionSelect={(_, data) => change(p.id, { action: data.optionValue as AiSignalAction })}>
                  {ACTIONS.map((action) => <Option key={action} value={action} text={actionLabel(action)}>{actionLabel(action)}</Option>)}
                </Dropdown>
              </div>
              <Field label={t.aiPrompt}>
                <Textarea value={prompt} placeholder={t.aiPromptPlaceholder} resize="vertical" rows={3} maxLength={4000}
                  onChange={(_, data) => setDrafts((all) => ({ ...all, [p.id]: data.value }))}
                  onBlur={() => { if (prompt !== config.prompt) change(p.id, { prompt }); }} />
              </Field>
            </div>
          );
        })}
      </div>
    </>
  );
}
