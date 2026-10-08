import { Button, Spinner } from '@fluentui/react-components';
import { CursorClick24Regular, Emoji24Regular, ImageAdd24Regular, ResizeLarge24Regular, Speaker224Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG } from '../../../shared/emoteCatalog';
import {
  MAX_CUSTOM_EMOTES, customHash, customStillUrl, emoteIconUrl, emoteName, type EmoteRef, type ImportError,
} from '../../../shared/emotes';
import type { Strings } from '../../../shared/i18n';
import { triggerLabel, type Settings } from '../../../shared/settings';
import type { WheelPatch } from '../../../shared/wheelLayout';
import { api } from '../api';
import { prepareEmote } from '../emoteImport';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SettingRow, SliderRow, SwitchRow } from './rows';
import { TriggerPicker } from './TriggerPicker';
import { WheelEditor, type PoolItem } from './WheelEditor';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

function importMessage(t: Strings, error: ImportError, file: string): string {
  switch (error) {
    case 'type': return t.importErrType(file);
    case 'size': return t.importErrSize(file);
    case 'animSize': return t.importErrAnimSize(file);
    case 'detail': return t.importErrDetail(file);
    case 'full': return t.importErrFull;
    case 'duplicate': return t.importErrDuplicate(file);
    default: return t.importErrDisk(file);
  }
}

/** Prepares one image here and hands it to main, which checks and saves it. */
async function importFile(file: File): Promise<ImportError | null> {
  try {
    const prepared = await prepareEmote(file);
    if (!prepared.ok) return prepared.error;
    const result = await api.importEmote(prepared.file);
    return result.ok ? null : result.error;
  } catch {
    return 'disk'; // the file couldn't be read, or main failed unexpectedly
  }
}

/**
 * Add image… and what an import has to say, under the pool. Files from the button or dropped on the pool are imported one
 * at a time; the errors of a batch stay until an import succeeds with none.
 */
function useImports(t: Strings) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // A file dropped anywhere else in the window would replace the settings page with the image: refuse such drops.
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);

  const importFiles = (files: File[]) => {
    if (files.length === 0) return;
    queue.current = queue.current.then(async () => {
      setBusy(true);
      const batch: string[] = [];
      for (const file of files) {
        const error = await importFile(file);
        if (error) batch.push(importMessage(t, error, file.name));
        setErrors([...batch]);
      }
      setBusy(false);
    });
  };
  return { busy, errors, importFiles, clearErrors: () => setErrors([]) };
}

/** The settings change for a wheel edit: only the fields it touches, since an undefined field would reset that setting. */
function emotePatch(p: WheelPatch<EmoteRef>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  if (p.wheel) patch.emoteWheel = p.wheel;
  if (p.center) patch.clickEmoteId = p.center;
  return patch;
}

export function EmoteSection({ settings: s, update, lengthUnit }: { settings: Settings; update: Update; lengthUnit: string }) {
  const t = useText();
  const [keyError, setKeyError] = useState<string | null>(null);
  // A refusal is about the keys as they were: it goes once any of them changes. (Compared by value; a refused patch still hands back a fresh settings object.)
  const keys = JSON.stringify([s.trigger, s.emoteTrigger, s.toggleHotkey]);
  useEffect(() => setKeyError(null), [keys]);
  const keyOff = s.emoteTrigger === 'off';
  const custom = typeof s.emoteTrigger === 'object';
  // With no key there is nothing to name in the labels, so they fall back to the row's own title.
  const key = s.emoteTrigger === 'off' ? t.emoteKey : triggerLabel(s.emoteTrigger, t.lang, api.platform);

  const { busy, errors, importFiles, clearErrors } = useImports(t);
  const picker = useRef<HTMLInputElement>(null);

  const pool: PoolItem<EmoteRef>[] = [
    ...EMOTE_CATALOG.map((e) => ({ id: e.slug, icon: emoteIconUrl(e.slug), name: emoteName(e.slug, t.lang, s.customEmotes) })),
    ...s.customEmotes.map((c) => ({
      id: c.id, icon: customStillUrl(customHash(c.id)), name: c.name,
      onRemove: () => {
        clearErrors();
        void api.removeEmote(c.id);
      },
    })),
  ];
  const importer = (
    <div className="weImport">
      <div className="weImportRow">
        <Button icon={busy ? <Spinner size="tiny" /> : <ImageAdd24Regular />} disabled={busy} onClick={() => picker.current?.click()}>
          {t.addImage}
        </Button>
        <span className="desc">{t.yourImages(s.customEmotes.length, MAX_CUSTOM_EMOTES)}</span>
      </div>
      <span className="desc">{t.addImageDesc}</span>
      {errors.map((e, i) => <div key={i} className="weImportError" role="alert">{e}</div>)}
      <input ref={picker} type="file" accept={ACCEPT} multiple hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]; // copied before the reset below empties the list
          e.target.value = ''; // so picking the same file again still counts as a change
          importFiles(files);
        }} />
    </div>
  );

  return (
    <>
      <SettingRow icon={<Emoji24Regular />} title={t.emoteKey}
        description={(
          <>
            {keyOff ? t.emoteKeyOffDesc : t.emoteKeyDesc}
            {custom ? <span className="desc">{t.customKeyNote}</span> : null}
          </>
        )}>
        <TriggerPicker value={s.emoteTrigger} offOption blocked={s.trigger}
          onChange={(k) => void update({ emoteTrigger: k }).then((r) => setKeyError(r.ok ? null : r.error))} />
      </SettingRow>
      {keyError ? <div className="rowError" role="alert">{keyError}</div> : null}
      <SwitchRow icon={<CursorClick24Regular />} title={t.emoteClick(key)} description={t.emoteClickDesc(key)}
        checked={s.emoteClick} onChange={(v) => void update({ emoteClick: v })} dim={keyOff} />
      <SliderRow limit="emoteSizePx" icon={<ResizeLarge24Regular />} title={t.emoteSize} value={s.emoteSizePx}
        format={(v) => `${v} ${lengthUnit}`} onChange={(v) => void update({ emoteSizePx: v })} dim={keyOff} />
      <SwitchRow icon={<Speaker224Regular />} title={t.emoteSound} description={t.emoteSoundDesc}
        checked={s.emoteSound} onChange={(v) => void update({ emoteSound: v })} dim={keyOff} />
      <WheelEditor wheel={s.emoteWheel} center={s.clickEmoteId} centerOn={s.emoteClick && !keyOff} trigger={key}
        pool={pool} poolExtra={importer} onDropFiles={importFiles}
        defaults={{ wheel: DEFAULT_EMOTE_WHEEL, center: DEFAULT_CLICK_EMOTE }}
        labels={{ title: t.emoteWheelTitle, desc: t.emoteWheelDesc(key), poolTitle: t.allEmotes, poolDesc: t.allEmotesDesc }}
        onChange={(patch) => void update(emotePatch(patch))} onPreview={(ref) => void api.previewEmote(ref)} />
    </>
  );
}
