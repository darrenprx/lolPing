import {
  Button, Caption1, Card as FluentCard, Input, makeStyles, mergeClasses, ProgressBar, Skeleton, SkeletonItem, Subtitle2,
  Text, tokens,
} from '@fluentui/react-components';
import {
  Checkmark16Regular, Copy16Regular, Dismiss16Regular, History16Regular, Send16Regular,
} from '@fluentui/react-icons';
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject,
} from 'react';
import type { Strings } from '../../shared/i18n';
import { MATE_TEXT_MAX, type CardState, type MateAction, type MateLeave } from '../../shared/teammateIpc';
import { useSurfaceStyles } from './Bubble';
import { cardButtons, copyText, footerText, PutGuard, putLabel } from './cardText';
import { dragHandle } from './drag';
import { contentHeight, HEIGHT_TARGET } from './easedHeight';
import { renderMarkdown } from './markdown';
import { reducedMotion, stagger, useMotion } from './motion';
import { NameTag } from './NameTag';

type Ui = Strings['teammate']['ui'];

const COPIED_MS = 1500;

const useStyles = makeStyles({
  card: {
    position: 'relative',
    overflow: 'hidden',
    width: '456px',
    maxHeight: '576px',
    boxSizing: 'border-box',
    padding: '10px 6px 8px 12px',
    rowGap: '8px',
    transitionProperty: 'height',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    '@media (prefers-reduced-motion: reduce)': { transitionProperty: 'none' },
  },
  /** While the answer streams, a thin bar runs along the card's top edge. */
  progress: { position: 'absolute', top: 0, left: 0, right: 0 },
  head: { display: 'flex', alignItems: 'center', columnGap: '8px', minWidth: 0 },
  title: { flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  body: {
    flexShrink: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '6px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: '10px',
  },
  entry: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  /** The user's side of the thread: a chip on the right with the ping's label and any words. */
  ask: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: '4px 10px 5px',
    borderRadius: tokens.borderRadiusXLarge,
    borderBottomRightRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    display: 'flex',
    flexDirection: 'column',
  },
  askLabel: { color: tokens.colorBrandForeground2 },
  askWords: { color: tokens.colorNeutralForeground1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  waiting: { display: 'flex', flexDirection: 'column', rowGap: '6px', paddingTop: '2px' },
  /** The bubble's line leads its answer. */
  lead: { display: 'block', marginBottom: '4px' },
  buttons: { display: 'flex', flexWrap: 'wrap', columnGap: '4px', rowGap: '4px', paddingRight: '6px' },
  reply: { marginRight: '6px' },
  footer: { color: tokens.colorNeutralForeground3, paddingRight: '6px' },
});

/**
 * The height the card should ease to: its content's, up to its maximum. It is worked out from the children's own
 * heights (the body by what it scrolls), not from the card's box, which is held at the last target while it eases.
 */
function useContentHeight(card: RefObject<HTMLElement | null>, body: RefObject<HTMLElement | null>): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  const watcher = useRef<ResizeObserver | null>(null);
  const measure = useCallback((): void => {
    const c = card.current;
    if (!c) return;
    const css = getComputedStyle(c);
    const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
      .reduce((sum, k) => sum + (parseFloat(css[k as 'paddingTop']) || 0), 0);
    const flow = [...c.children].filter((el) => getComputedStyle(el).position !== 'absolute');
    const heights = flow.map((el) => (el === body.current ? el.scrollHeight : (el as HTMLElement).offsetHeight));
    const next = contentHeight(chrome, parseFloat(css.rowGap) || 0, heights, parseFloat(css.maxHeight) || Infinity);
    setHeight((h) => (h === next ? h : next));
  }, [card, body]);
  // After every render, and whenever a child changes size without one (a font arriving, Markdown laying out).
  useLayoutEffect(() => {
    measure();
    const c = card.current;
    if (!c) return;
    watcher.current ??= new ResizeObserver(measure);
    for (const el of [...c.children, ...(body.current?.children ?? [])]) {
      if (el !== body.current) watcher.current.observe(el);
    }
  });
  useEffect(() => () => watcher.current?.disconnect(), []);
  return height;
}

/** The model's Markdown, sanitised; web links become `link` actions and code blocks get a Copy button. */
function Markdown({ md, t, act, className }: { md: string; t: Ui; act: (a: MateAction) => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(md), [md]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    for (const link of el.querySelectorAll('[data-link]')) {
      link.setAttribute('role', 'link');
      link.setAttribute('tabindex', '0');
    }
    for (const pre of el.querySelectorAll('pre')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mate-copy-code';
      b.textContent = t.copyCode;
      pre.append(b);
    }
  }, [html, t]);
  const activate = (target: EventTarget): boolean => {
    if (!(target instanceof Element)) return false;
    const copy = target.closest('.mate-copy-code');
    if (copy) {
      act({ t: 'copy', text: copy.parentElement?.querySelector('code')?.textContent ?? '' });
      return true;
    }
    const url = target.closest('[data-link]')?.getAttribute('data-link');
    if (url) act({ t: 'link', url });
    return Boolean(url);
  };
  const onClick = (e: MouseEvent): void => {
    if (activate(e.target)) e.preventDefault();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && e.target instanceof Element && e.target.hasAttribute('data-link') && activate(e.target)) {
      e.preventDefault();
    }
  };
  return <div ref={ref} className={mergeClasses('mate-md', className)} onClick={onClick} onKeyDown={onKeyDown} />;
}

export function Card({ s, t, act, leaving }: { s: CardState; t: Ui; act: (a: MateAction) => void; leaving: MateLeave | null }) {
  const st = useStyles();
  const sf = useSurfaceStyles();
  const m = useMotion();
  const [reply, setReply] = useState('');
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const height = useContentHeight(cardRef, bodyRef);
  // Entries the card opened with rise in one after another; each one added later rises as it comes (keys are stable).
  const opened = useRef(s.entries.length).current;
  // Answers that shimmered while they waited: their text rises in when it arrives.
  const waited = useRef(new Set<number>()).current;
  // Answers shown with their line alone: their card answer rises in when it comes.
  const lineFirst = useRef(new Set<number>()).current;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) act({ t: 'close' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act]);

  // While the answer streams in, keep its end in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !s.streaming) return;
    const smooth = !reducedMotion();
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, [s]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const sendReply = (): void => {
    const text = reply.trim();
    if (!text) return;
    act({ t: 'reply', text });
    setReply('');
  };
  const copyAll = (): void => {
    act({ t: 'copy', text: copyText(s.entries) });
    setCopied(true);
  };
  const leave = leaving === 'stale' ? m.stale : leaving === 'fast' ? m.shrink : undefined;
  const put = putLabel(s.put, t);
  const [guard] = useState(() => new PutGuard(() => performance.now()));
  guard.show(put);
  // The head drags the card; its text stays selectable.
  const [drag] = useState(() => dragHandle((d) => window.mateApi.drag(d)));
  const button = (b: ReturnType<typeof cardButtons>[number]) => {
    switch (b) {
      case 'copy':
        return (
          <Button
            key="copy"
            size="small"
            icon={copied ? <Checkmark16Regular className={m.pop} /> : <Copy16Regular />}
            onClick={copyAll}
          >
            {copied ? t.copied : t.copy}
          </Button>
        );
      case 'deep':
        return (
          <Button key="deep" size="small" onClick={() => act({ t: 'deep' })}>
            {t.wholePicture}
          </Button>
        );
      case 'history':
        return (
          <Button key="history" size="small" icon={<History16Regular />} onClick={() => act({ t: 'history' })}>
            {t.history}
          </Button>
        );
      case 'put':
        return (
          <Button
            key={`put:${put}`}
            className={m.pop}
            size="small"
            appearance="primary"
            onClick={() => guard.click() && act({ t: 'put' })}
          >
            {put}
          </Button>
        );
    }
  };
  return (
    <div className={sf.frame}>
      <FluentCard
        ref={cardRef}
        className={mergeClasses(sf.surface, st.card, m.grow, leave)}
        style={height === undefined ? undefined : { height }}
        {...{ [HEIGHT_TARGET]: height }}
      >
        {s.streaming && <ProgressBar className={st.progress} thickness="medium" shape="square" aria-hidden />}
        <div className={st.head} data-mate-drag {...drag}>
          <NameTag tag={s.tag} thinking={s.streaming} thinkingLabel={t.thinking} />
          <Subtitle2 className={st.title}><span data-mate-text>{s.title}</span></Subtitle2>
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            aria-label={t.close}
            onClick={() => act({ t: 'close' })}
          />
        </div>
        <div className={st.body} ref={bodyRef}>
          {s.entries.map((e, i) => {
            const style = stagger(i < opened ? i : 0);
            if (e.kind === 'ask') {
              return (
                <div key={i} className={mergeClasses(st.ask, m.rise)} style={style}>
                  <Caption1 className={st.askLabel}>{e.label}</Caption1>
                  {e.markdown && <Text className={st.askWords}>{e.markdown}</Text>}
                </div>
              );
            }
            // An answer that hasn't started yet shimmers where its text will be.
            const waiting = !e.line && !e.markdown && s.streaming && i === s.entries.length - 1;
            if (waiting) waited.add(i);
            if (e.line && !e.markdown) lineFirst.add(i);
            return (
              <div key={i} className={mergeClasses(st.entry, m.rise)} style={style}>
                {waiting ? (
                  <Skeleton className={st.waiting} aria-label={t.thinking}>
                    <SkeletonItem size={12} style={{ width: '92%' }} />
                    <SkeletonItem size={12} style={{ width: '78%' }} />
                    <SkeletonItem size={12} style={{ width: '54%' }} />
                  </Skeleton>
                ) : (
                  <>
                    {e.line && (
                      <Text weight="semibold" className={mergeClasses(st.lead, waited.has(i) && m.rise)}>{e.line}</Text>
                    )}
                    {e.markdown && (
                      <Markdown md={e.markdown} t={t} act={act} className={lineFirst.has(i) ? m.rise : undefined} />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {/* The put button is last: its arrival moves none of the others from under the pointer. */}
        <div className={st.buttons}>{cardButtons(put, s.answerOnly).map(button)}</div>
        {!s.answerOnly && <Input
          className={st.reply}
          size="small"
          placeholder={t.reply}
          value={reply}
          maxLength={MATE_TEXT_MAX}
          onChange={(_e, d) => setReply(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendReply();
          }}
          contentAfter={
            <Button size="small" appearance="transparent" icon={<Send16Regular />} aria-label={t.send} onClick={sendReply} />
          }
        />}
        <Caption1 className={st.footer}>{footerText(s.footer, t)}</Caption1>
      </FluentCard>
    </div>
  );
}
