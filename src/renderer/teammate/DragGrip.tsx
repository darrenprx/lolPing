import { makeStyles, tokens } from '@fluentui/react-components';
import type { dragHandle } from './drag';

const useStyles = makeStyles({
  grip: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '72px',
    minHeight: '24px',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, color: tokens.colorNeutralForeground1 },
  },
});

/** A full-width target that stays easy to grab even when the answer fills the window. */
export function DragGrip({ label, handlers }: { label: string; handlers?: ReturnType<typeof dragHandle> }) {
  const st = useStyles();
  return (
    <div className={st.grip} data-mate-drag title={label} {...handlers}>
      <svg width="24" height="12" viewBox="0 0 24 12" fill="currentColor" aria-hidden="true">
        {[6, 12, 18].map((x) => <g key={x}><circle cx={x} cy="3" r="1.5" /><circle cx={x} cy="9" r="1.5" /></g>)}
      </svg>
    </div>
  );
}
