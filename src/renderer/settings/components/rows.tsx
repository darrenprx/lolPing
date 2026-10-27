import { Slider, Switch } from '@fluentui/react-components';
import { ChevronDown20Regular } from '@fluentui/react-icons';
import { Collapse } from '@fluentui/react-motion-components-preview';
import { useId, useState, type ReactNode } from 'react';
import { LIMITS } from '../../../shared/settings';
import { useText } from '../text';

export function SettingRow(props: { icon: ReactNode; title: ReactNode; description?: ReactNode; dim?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`card${props.dim ? ' dim' : ''}${props.className ? ` ${props.className}` : ''}`}>
      {props.icon === null ? null : <span className="icon">{props.icon}</span>}
      <div className="lbl">
        {props.title}
        {props.description ? <span className="desc">{props.description}</span> : null}
      </div>
      <div className="ctl">{props.children}</div>
    </div>
  );
}

/** A switch with its On/Off text, as every settings row shows it. */
export function OnOffSwitch(props: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label?: string }) {
  const t = useText();
  return (
    <Switch checked={props.checked} disabled={props.disabled} aria-label={props.label} onChange={(_, d) => props.onChange(d.checked)}
      label={props.checked ? t.on : t.off} labelPosition="before" />
  );
}

export function SwitchRow(props: { icon: ReactNode; title: ReactNode; description?: ReactNode; checked: boolean; onChange(v: boolean): void; dim?: boolean; disabled?: boolean }) {
  return (
    <SettingRow icon={props.icon} title={props.title} description={props.description} dim={props.dim}>
      <OnOffSwitch checked={props.checked} disabled={props.disabled} onChange={props.onChange} />
    </SettingRow>
  );
}

/**
 * A row that opens to show the rows under it, like an expander in Windows Settings. Clicking the header or its chevron
 * toggles it; `control` (a switch, say) stays usable without toggling. Closed content stays mounted, so drafts survive.
 */
export function ExpanderRow(props: {
  icon: ReactNode; title: ReactNode; description?: ReactNode; control?: ReactNode; defaultOpen?: boolean; dim?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const id = useId();
  return (
    <div className={`card expander${open ? ' open' : ''}${props.dim ? ' dim' : ''}`}>
      <div className="expHead" onClick={() => setOpen(!open)}>
        <span className="icon">{props.icon}</span>
        <div className="lbl">
          <span id={`${id}-title`}>{props.title}</span>
          {props.description ? <span className="desc">{props.description}</span> : null}
        </div>
        {props.control ? <div className="ctl" onClick={(e) => e.stopPropagation()}>{props.control}</div> : null}
        <button type="button" className="expChevron" aria-expanded={open} aria-controls={`${id}-body`}
          aria-labelledby={`${id}-title`} onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}>
          <ChevronDown20Regular />
        </button>
      </div>
      <Collapse visible={open}>
        <div id={`${id}-body`} className="expBody" inert={!open}>{props.children}</div>
      </Collapse>
    </div>
  );
}

export function SliderRow(props: {
  limit: keyof typeof LIMITS;
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  value: number;
  format(v: number): string;
  onChange(v: number): void;
  dim?: boolean;
}) {
  const { min, max, step } = LIMITS[props.limit];
  return (
    <SettingRow icon={props.icon} title={props.title} description={props.description} dim={props.dim}>
      <Slider min={min} max={max} step={step} value={props.value} onChange={(_, d) => props.onChange(d.value)} style={{ width: 200 }} />
      <span className="value">{props.format(props.value)}</span>
    </SettingRow>
  );
}
