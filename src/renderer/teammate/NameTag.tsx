import { makeStyles, tokens } from '@fluentui/react-components';
import type { PingTag } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import { useMotion } from './motion';

const useStyles = makeStyles({
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    padding: '1px 8px',
    borderRadius: tokens.borderRadiusCircular,
    // The same dark pill as the overlay's name tags, so the teammate looks the same everywhere.
    backgroundColor: 'rgba(8, 12, 16, .78)',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: 'nowrap',
  },
});

/** The teammate's name chip in its tag colour; three soft dots while it thinks. */
export function NameTag({ tag, thinking, thinkingLabel }: { tag: PingTag; thinking: boolean; thinkingLabel: string }) {
  const s = useStyles();
  const m = useMotion();
  return (
    <span className={s.tag} style={{ color: tagColorCss(tag.color, tag.rgb) }} data-mate-text>
      {tag.name}
      {thinking && (
        <span role="status" aria-label={thinkingLabel}>
          <span className={m.dot} />
          <span className={m.dot} />
          <span className={m.dot} />
        </span>
      )}
    </span>
  );
}
