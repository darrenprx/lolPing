import { Button, Caption1, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import type { Strings } from '../../shared/i18n';
import type { BubbleState, MateAction, MateLeave } from '../../shared/teammateIpc';
import { bubbleButtons, PutGuard, putLabel } from './cardText';
import { dragHandle } from './drag';
import { DragGrip } from './DragGrip';
import { useMotion } from './motion';
import { NameTag } from './NameTag';

export const useSurfaceStyles = makeStyles({
  /** Room around the surface for its shadow: the window is transparent there. */
  frame: { padding: '12px' },
  surface: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow16,
    border: `1px solid ${tokens.colorTransparentStroke}`,
  },
});

const useStyles = makeStyles({
  bubble: {
    maxWidth: '416px',
    padding: '8px 6px 8px 10px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: '4px',
  },
  head: { display: 'flex', alignItems: 'center', columnGap: '6px', minWidth: 0 },
  thread: {
    flexGrow: 1,
    minWidth: 0,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  spacer: { flexGrow: 1 },
  body: { display: 'flex', alignItems: 'flex-end', columnGap: '6px', paddingRight: '4px' },
  line: { flexGrow: 1 },
});

export function Bubble({ s, t, act, leaving }: {
  s: BubbleState; t: Strings['teammate']['ui']; act: (a: MateAction) => void; leaving: MateLeave | null;
}) {
  const st = useStyles();
  const sf = useSurfaceStyles();
  const m = useMotion();
  const leave = leaving === 'stale' ? m.stale : leaving === 'fast' ? m.fadeOut : undefined;
  const put = putLabel(s.put, t);
  const [guard] = useState(() => new PutGuard(() => performance.now()));
  guard.show(put);
  // Background space drags the bubble; text stays selectable and buttons still click.
  const [drag] = useState(() => dragHandle((d) => window.mateApi.drag(d)));
  return (
    <div className={sf.frame}>
      <div className={mergeClasses(sf.surface, st.bubble, m.appear, leave)} data-mate-drag {...drag}>
        <DragGrip label={t.moveWindow} />
        <div className={st.head}>
          <NameTag tag={s.tag} thinking={s.thinking} thinkingLabel={t.thinking} />
          {s.thread ? (
            <Caption1 className={st.thread}><span data-mate-text>↳ {s.thread}</span></Caption1>
          ) : <span className={st.spacer} />}
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            aria-label={t.dismiss}
            onClick={() => act({ t: 'dismiss' })}
          />
        </div>
        {(s.line || s.more || put) && (
          <div className={st.body}>
            {/* Keyed by the line, so a new line settles in instead of swapping in place. */}
            <div className={st.line}>
              <Text key={s.line} className={m.rise} data-mate-text>{s.line}</Text>
            </div>
            {bubbleButtons(s.more, put).map((b) => (b === 'more' ? (
              <Button key="more" className={m.pop} size="small" appearance="primary" onClick={() => act({ t: 'more' })}>
                {t.more}
              </Button>
            ) : (
              // Keyed by the label, so Paste turning into Paste when ready pops in again.
              <Button
                key={`put:${put}`}
                className={m.pop}
                size="small"
                onClick={() => guard.click() && act({ t: 'put' })}
              >
                {put}
              </Button>
            )))}
          </div>
        )}
      </div>
    </div>
  );
}
