import { Dropdown, Option, OptionGroup } from '@fluentui/react-components';
import { useState } from 'react';
import { UNSAFE_TRIGGER_VKS, vkLabel } from '../../../shared/keys';
import {
  keyboardTriggers, sameTrigger, triggerLabel, triggerVk, type EmoteTriggerKey, type NamedTrigger,
} from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import { KeyCapture } from './KeyCapture';

const KEYBOARD: NamedTrigger[] = keyboardTriggers(api.platform);

/**
 * Fluent Dropdown (never a native <select>) with Keyboard / Mouse groups and a custom key option.
 * `offOption` adds an Off choice. `blocked` is the other trigger's key: it can't be picked here, so its option is disabled
 * and the custom-key capture refuses it.
 */
export function TriggerPicker({ value, onChange, offOption, blocked }: {
  value: EmoteTriggerKey;
  onChange(t: EmoteTriggerKey): void;
  offOption?: boolean;
  blocked?: EmoteTriggerKey;
}) {
  const t = useText();
  const isCustom = typeof value === 'object';
  const [choosingCustom, setChoosingCustom] = useState(false);
  const showCustom = isCustom || choosingCustom;
  const selected = showCustom ? 'custom' : (value as NamedTrigger | 'off');
  const isBlocked = (k: NamedTrigger) => blocked !== undefined && sameTrigger(k, blocked);
  const blockedVk = blocked === undefined ? null : triggerVk(blocked);
  const forbiddenVks = blockedVk === null ? UNSAFE_TRIGGER_VKS : [...UNSAFE_TRIGGER_VKS, blockedVk];

  return (
    <>
      {showCustom ? (
        <KeyCapture
          key={choosingCustom ? 'choosing' : 'idle'}
          parts={isCustom ? [vkLabel(value.vk, api.platform)] : [t.chooseKey]}
          requireModifier={false}
          forbiddenVks={forbiddenVks}
          autoListen={choosingCustom}
          onCancel={() => setChoosingCustom(false)}
          onCapture={(c) => {
            setChoosingCustom(false);
            onChange({ vk: c.vk });
          }}
        />
      ) : null}
      <Dropdown
        style={{ minWidth: 170 }}
        value={showCustom ? t.customKey : value === 'off' ? t.emoteKeyOff : triggerLabel(value, t.lang, api.platform)}
        selectedOptions={[selected]}
        onOptionSelect={(_, d) => {
          if (d.optionValue === 'custom') {
            setChoosingCustom(true);
          } else if (d.optionValue) {
            setChoosingCustom(false);
            onChange(d.optionValue as EmoteTriggerKey);
          }
        }}
      >
        {offOption ? <Option value="off" text={t.emoteKeyOff}>{t.emoteKeyOff}</Option> : null}
        <OptionGroup label={t.keyboard}>
          {KEYBOARD.map((k) => (
            <Option key={k} value={k} disabled={isBlocked(k)}>{triggerLabel(k, t.lang, api.platform)}</Option>
          ))}
        </OptionGroup>
        <OptionGroup label={t.mouse}>
          <Option value="mouse4" text={t.mouse4} disabled={isBlocked('mouse4')}>{t.mouse4}<span className="desc inline">{t.mouseBack}</span></Option>
          <Option value="mouse5" text={t.mouse5} disabled={isBlocked('mouse5')}>{t.mouse5}<span className="desc inline">{t.mouseForward}</span></Option>
        </OptionGroup>
        <Option value="custom" text={t.customKeyMenu}>{t.customKeyMenu}</Option>
      </Dropdown>
    </>
  );
}
