import { Button, Dropdown, Input, Option } from '@fluentui/react-components';
import {
  Bot24Regular, Camera24Regular, Desktop24Regular, Globe24Regular, Key24Regular, NumberSymbol24Regular, PlugConnected24Regular,
  QuestionCircle24Regular, Timer24Regular,
} from '@fluentui/react-icons';
import { useEffect, useState, type ReactNode } from 'react';
import type { Strings } from '../../../shared/i18n';
import type { AiTestResult, SetSettingsResult } from '../../../shared/ipc';
import { ALL_PINGS, type PingId } from '../../../shared/pings';
import { AI_BASE_URL_DEFAULT, AI_MODEL_DEFAULT, type AiAnswerStyle, type Settings } from '../../../shared/settings';
import { SettingRow, SliderRow, SwitchRow } from './rows';
import { useText } from '../text';

type Update = (patch: Partial<Settings>) => Promise<SetSettingsResult>;

/** A text field that commits on blur or Enter, so a keystroke isn't a settings write. */
function TextRow(props: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  value: string;
  placeholder?: string;
  password?: boolean;
  dim?: boolean;
  onCommit(v: string): void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    const v = draft.trim();
    if (v !== props.value) props.onCommit(v);
  };
  return (
    <SettingRow icon={props.icon} title={props.title} description={props.description} dim={props.dim}>
      <Input
        style={{ width: 300 }}
        value={draft}
        placeholder={props.placeholder}
        type={props.password ? 'password' : 'text'}
        onChange={(_, d) => setDraft(d.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </SettingRow>
  );
}

export function AiSection({ settings: s, update }: { settings: Settings; update: Update }) {
  const t = useText();
  const [test, setTest] = useState<{ state: 'idle' | 'busy'; result?: AiTestResult }>({ state: 'idle' });

  const runTest = async () => {
    setTest({ state: 'busy' });
    const result = await window.settingsApi.testAi({ baseUrl: s.aiBaseUrl, apiKey: s.aiApiKey, model: s.aiModel });
    setTest({ state: 'idle', result });
  };

  const testLine = (t: Strings): ReactNode => {
    if (test.state === 'busy') return t.aiTesting;
    const r = test.result;
    if (!r) return '';
    if (r.ok) return t.aiTestOk;
    return t.aiTestFail(testFailText(t, r, s.aiModel));
  };

  return (
    <>
      <div className="section" id="ai">{t.navAi}</div>
      <SwitchRow icon={<Camera24Regular />} title={t.aiEnable} description={t.aiEnableDesc}
        checked={s.aiEnabled} onChange={(v) => void update({ aiEnabled: v })} />
      <SettingRow icon={<QuestionCircle24Regular />} title={t.aiTriggerPing} description={t.aiTriggerPingDesc}>
        <Dropdown style={{ minWidth: 170 }} value={t.pingNames[s.aiTriggerPingId]} selectedOptions={[s.aiTriggerPingId]}
          onOptionSelect={(_, d) => void update({ aiTriggerPingId: d.optionValue as PingId })}>
          {ALL_PINGS.map((p) => (
            <Option key={p.id} value={p.id} text={t.pingNames[p.id]}>{t.pingNames[p.id]}</Option>
          ))}
        </Dropdown>
      </SettingRow>
      <SliderRow limit="aiTriggerCount" icon={<NumberSymbol24Regular />} title={t.aiTriggerCount} description={t.aiTriggerCountDesc}
        value={s.aiTriggerCount} format={(v) => `${v}`} onChange={(v) => void update({ aiTriggerCount: v })} dim={!s.aiEnabled} />
      <SliderRow limit="aiTriggerWindowS" icon={<Timer24Regular />} title={t.aiTriggerWindow} description={t.aiTriggerWindowDesc}
        value={s.aiTriggerWindowS} format={(v) => `${v} s`} onChange={(v) => void update({ aiTriggerWindowS: v })} dim={!s.aiEnabled} />
      <TextRow icon={<Globe24Regular />} title={t.aiBaseUrl} description={t.aiBaseUrlDesc} value={s.aiBaseUrl}
        placeholder={AI_BASE_URL_DEFAULT} onCommit={(v) => void update({ aiBaseUrl: v })} dim={!s.aiEnabled} />
      <TextRow icon={<Key24Regular />} title={t.aiApiKey} description={t.aiApiKeyDesc} value={s.aiApiKey} password
        onCommit={(v) => void update({ aiApiKey: v })} dim={!s.aiEnabled} />
      <TextRow icon={<Bot24Regular />} title={t.aiModel} description={t.aiModelDesc} value={s.aiModel}
        placeholder={AI_MODEL_DEFAULT} onCommit={(v) => void update({ aiModel: v })} dim={!s.aiEnabled} />
      <SettingRow icon={<PlugConnected24Regular />} title={t.aiTest} description={<span className="desc">{testLine(t)}</span>} dim={!s.aiEnabled}>
        <Button appearance="primary" disabled={test.state === 'busy' || !s.aiEnabled} onClick={() => void runTest()}>{t.aiTest}</Button>
      </SettingRow>
      <SettingRow icon={<Desktop24Regular />} title={t.aiAnswerStyle} description={t.aiAnswerStyleDesc}>
        <Dropdown style={{ minWidth: 170 }} value={s.aiAnswerStyle === 'card' ? t.aiAnswerCard : t.aiAnswerFullscreen}
          selectedOptions={[s.aiAnswerStyle]}
          onOptionSelect={(_, d) => void update({ aiAnswerStyle: d.optionValue as AiAnswerStyle })}>
          <Option value="fullscreen" text={t.aiAnswerFullscreen}>{t.aiAnswerFullscreen}</Option>
          <Option value="card" text={t.aiAnswerCard}>{t.aiAnswerCard}</Option>
        </Dropdown>
      </SettingRow>
      <SliderRow limit="aiCardSeconds" icon={<Timer24Regular />} title={t.aiCardSeconds} description={t.aiCardSecondsDesc}
        value={s.aiCardSeconds} format={(v) => `${v} s`} onChange={(v) => void update({ aiCardSeconds: v })}
        dim={!s.aiEnabled || s.aiAnswerStyle !== 'card'} />
    </>
  );
}

/** The user-facing line for a test failure, in the app language (mirrors the main process's toasts). */
function testFailText(t: Strings, r: Extract<AiTestResult, { ok: false }>, model: string): string {
  switch (r.reason) {
    case 'noKey': return t.aiToastNoKey;
    case 'network': return t.aiErrNetwork;
    case 'auth': return t.aiErrAuth;
    case 'model': return t.aiErrModel(model);
    case 'busy': return t.aiErrBusy;
    case 'response': return t.aiErrResponse;
    case 'timeout': return t.aiErrTimeout;
    default: return t.aiErrUnknown(r.detail);
  }
}
