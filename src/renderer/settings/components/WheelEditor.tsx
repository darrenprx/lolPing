import { Button } from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { dropPatch, type WheelPatch, type WheelSource, type WheelTarget } from '../../../shared/wheelLayout';
import { useText } from '../text';

// Geometry of the editor wheel, in CSS pixels.
const SIZE = 300;
const C = SIZE / 2;
const R_IN = 52;
const R_OUT = 146;
const R_ICON = 100;
const GAP = 0.035;
const pt = (r: number, a: number): string => `${C + r * Math.sin(a)},${C - r * Math.cos(a)}`;
const wedgePath = (i: number): string => {
  const a0 = ((i - 0.5) * Math.PI) / 4 + GAP;
  const a1 = ((i + 0.5) * Math.PI) / 4 - GAP;
  return `M${pt(R_IN, a0)} A${R_IN},${R_IN} 0 0 1 ${pt(R_IN, a1)} L${pt(R_OUT, a1)} A${R_OUT},${R_OUT} 0 0 0 ${pt(R_OUT, a0)}Z`;
};

/** One thing that can go on the wheel, a ping or an emote. `badge` is a small tag on its tile; `onRemove` adds an × to it. */
export interface PoolItem<T extends string> {
  id: T;
  icon: string;
  name: string;
  badge?: string;
  onRemove?: () => void;
}

interface Props<T extends string> {
  wheel: readonly T[];
  center: T;
  centerOn: boolean;
  trigger: string;
  pool: readonly PoolItem<T>[];
  defaults: { wheel: readonly T[]; center: T };
  labels: { title: string; desc: string; poolTitle: string; poolDesc: string };
  /** Rendered under the pool's tiles, outside their scroll box, so it stays in view however long the pool is. */
  poolExtra?: ReactNode;
  /** Files dragged in from outside and dropped on the pool. Without it the pool takes no files. */
  onDropFiles?: (files: File[]) => void;
  onChange: (patch: WheelPatch<T>) => void;
  onPreview: (id: T) => void;
}

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

export function WheelEditor<T extends string>({
  wheel, center, centerOn, trigger, pool, defaults, labels, poolExtra, onDropFiles, onChange, onPreview,
}: Props<T>) {
  const t = useText();
  const [picked, setPicked] = useState<WheelSource<T> | null>(null);
  const [hot, setHot] = useState<WheelTarget | null>(null);
  const [filesOver, setFilesOver] = useState(false);
  const drag = useRef<WheelSource<T> | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const apply = (src: WheelSource<T>, target: WheelTarget) => {
    const patch = dropPatch(wheel, center, src, target);
    if (patch) onChange(patch);
    setPicked(null);
  };

  /** Click on a slot or the centre: place the picked item there, or pick up what's there. */
  const clickTarget = (target: WheelTarget, here: WheelSource<T>) => {
    if (picked) apply(picked, target);
    else setPicked(here);
  };

  const dragProps = (src: WheelSource<T>) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      drag.current = src;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', src.id);
    },
    onDragEnd: () => {
      drag.current = null;
      setHot(null);
    },
  });

  const dropProps = (target: WheelTarget) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag.current) return;
      e.preventDefault();
      setHot(target);
    },
    onDragLeave: () => setHot((h) => (h === target ? null : h)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setHot(null);
      if (drag.current) apply(drag.current, target);
      drag.current = null;
    },
  });

  /** Only a drag of files from outside: a tile being dragged carries text, never files. */
  const takesFiles = (e: DragEvent): boolean => onDropFiles !== undefined && !drag.current && e.dataTransfer.types.includes('Files');
  const fileDropProps = {
    onDragOver: (e: DragEvent) => {
      if (!takesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setFilesOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFilesOver(false); // left the pool, not just a tile
    },
    onDrop: (e: DragEvent) => {
      setFilesOver(false);
      if (!takesFiles(e)) return;
      e.preventDefault();
      onDropFiles?.([...e.dataTransfer.files]);
    },
  };

  const byId = new Map(pool.map((p) => [p.id, p]));
  const name = (id: T) => byId.get(id)?.name ?? '?';
  const icon = (id: T) => byId.get(id)?.icon;
  const isPicked = (match: (p: WheelSource<T>) => boolean) => (picked !== null && match(picked) ? ' picked' : '');

  return (
    <div className="card wheelEditor">
      <div className="weHead">
        <div className="lbl">
          {labels.title}
          <span className="desc">{labels.desc}</span>
        </div>
        <Button
          onClick={() => {
            setPicked(null);
            onChange({ wheel: [...defaults.wheel], center: defaults.center });
          }}
        >
          {t.wheelReset}
        </Button>
      </div>
      <div className="weBody">
        <div className="weWheel" style={{ width: SIZE, height: SIZE }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
            {wheel.map((id, i) => (
              <path key={i} d={wedgePath(i)} className={`weWedge${hot === i ? ' hot' : ''}`} {...dropProps(i)}
                onClick={() => clickTarget(i, { from: 'slot', id, slot: i })} />
            ))}
          </svg>
          {wheel.map((id, i) => {
            const a = (i * Math.PI) / 4;
            const label = t.wheelSlotLabel(t.slotNames[i], name(id));
            return (
              <div key={i} role="button" tabIndex={0} aria-label={label} title={label}
                className={`weSlot${hot === i ? ' hot' : ''}${isPicked((p) => p.from === 'slot' && p.slot === i)}`}
                style={{ left: C + R_ICON * Math.sin(a), top: C - R_ICON * Math.cos(a) }}
                {...dragProps({ from: 'slot', id, slot: i })} {...dropProps(i)}
                onClick={() => clickTarget(i, { from: 'slot', id, slot: i })}
                onKeyDown={activate(() => clickTarget(i, { from: 'slot', id, slot: i }))}>
                <img src={icon(id)} alt="" />
              </div>
            );
          })}
          <div role="button" tabIndex={0} aria-label={t.wheelCenterLabel(trigger, name(center))}
            title={t.wheelCenterLabel(trigger, name(center))}
            className={`weCenter${hot === 'center' ? ' hot' : ''}${centerOn ? '' : ' off'}${isPicked((p) => p.from === 'center')}`}
            {...dragProps({ from: 'center', id: center })} {...dropProps('center')}
            onClick={() => clickTarget('center', { from: 'center', id: center })}
            onKeyDown={activate(() => clickTarget('center', { from: 'center', id: center }))}>
            <img src={icon(center)} alt="" />
            <span>{t.wheelCenter}</span>
          </div>
        </div>
        <div className={`wePool${filesOver ? ' filesOver' : ''}`} {...fileDropProps}>
          <div className="wePoolTitle">{labels.poolTitle}</div>
          <span className="desc">{labels.poolDesc}</span>
          <div className="weTiles">
            {pool.map((p) => {
              const slot = wheel.indexOf(p.id);
              const pick = () => {
                onPreview(p.id);
                setPicked((cur) => (cur?.from === 'pool' && cur.id === p.id ? null : { from: 'pool', id: p.id }));
              };
              return (
                <div key={p.id} className={`weCell${p.onRemove ? ' removable' : ''}`}>
                  <div role="button" tabIndex={0}
                    className={`weTile${isPicked((s) => s.from === 'pool' && s.id === p.id)}`}
                    {...dragProps({ from: 'pool', id: p.id })} onClick={pick} onKeyDown={activate(pick)}>
                    {p.badge ? <span className="weNew">{p.badge}</span> : null}
                    {slot >= 0 ? <span className="weWhere">{t.slotNames[slot]}</span> : null}
                    <img src={p.icon} alt="" />
                    {p.name}
                  </div>
                  {p.onRemove ? (
                    <button type="button" className="weRemove" aria-label={t.removeImage(p.name)} title={t.removeImage(p.name)}
                      onClick={p.onRemove}>
                      <DismissRegular />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {poolExtra}
        </div>
      </div>
      <div className="weHint" aria-live="polite">{picked ? t.wheelPickHint(name(picked.id)) : ' '}</div>
    </div>
  );
}
