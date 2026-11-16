import { Button, Menu, MenuDivider, MenuItem, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, Spinner } from '@fluentui/react-components';
import {
  CursorClick24Regular, Emoji24Regular, ImageAdd24Regular, ResizeLarge24Regular, Speaker2Regular, Speaker224Regular, SpeakerMuteRegular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG } from '../../../shared/emoteCatalog';
import {
  MAX_CUSTOM_EMOTES, customHash, customStillUrl, emoteIconUrl, emoteName, type CustomEmote, type EmoteRef, type ImportError,
  type SoundError,
} from '../../../shared/emotes';
import type { Strings } from '../../../shared/i18n';
import { leagueSoundChoices, type LeagueSoundRef } from '../../../shared/leagueSounds';
import { separateAskKey, triggerLabel, type Settings } from '../../../shared/settings';
import type { WheelPatch } from '../../../shared/wheelLayout';
import { api } from '../api';
import { prepareEmote, prepareSound } from '../emoteImport';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SettingRow, SliderRow, SwitchRow } from './rows';
import { TriggerPicker } from './TriggerPicker';
import { WheelEditor, type PoolItem } from './WheelEditor';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const ACCEPT_SOUND = 'audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav';
const LEAGUE_SOUNDS = leagueSoundChoices();

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

function soundMessage(t: Strings, error: SoundError, file: string): string {
  switch (error) {
    case 'type': return t.soundErrType(file);
    case 'size': return t.soundErrSize(file);
    case 'long': return t.soundErrLong(file);
    default: return t.importErrDisk(file);
  }
}

/** Checks a sound here and hands it to main, which checks and saves it again. */
async function soundFile(id: EmoteRef, file: File): Promise<SoundError | null> {
  try {
    const prepared = await prepareSound(file);
    if (!prepared.ok) return prepared.error;
    const result = await api.setEmoteSound(id, prepared.bytes);
    return result.ok ? null : result.error;
  } catch {
    return 'disk';
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
  /** Gives emote `id` the sound in `file`, in the same queue as the imports; its error shows with theirs. */
  const importSound = (id: EmoteRef, file: File) => {
    queue.current = queue.current.then(async () => {
      setBusy(true);
      const error = await soundFile(id, file);
      setErrors(error ? [soundMessage(t, error, file.name)] : []);
      setBusy(false);
    });
  };
  return { busy, errors, importFiles, importSound, clearErrors: () => setErrors([]) };
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
  const askKey = separateAskKey(s);
  const custom = typeof s.emoteTrigger === 'object';
  // With no key there is nothing to name in the labels, so they fall back to the row's own title.
  const key = s.emoteTrigger === 'off' ? t.emoteKey : triggerLabel(s.emoteTrigger, t.lang, api.platform);

  const { busy, errors, importFiles, importSound, clearErrors } = useImports(t);
  const picker = useRef<HTMLInputElement>(null);
  const soundPicker = useRef<HTMLInputElement>(null);
  const soundFor = useRef<EmoteRef | null>(null); // the emote whose speaker opened the sound picker
  const soundTool = (c: CustomEmote): PoolItem<EmoteRef>['tool'] => {
    const on = c.sound === true || c.leagueSound !== undefined;
    // One radio group across the menu and its two submenus: the sound this image has now.
    const checked = { sound: [c.sound ? 'file' : c.leagueSound ?? 'none'] };
    const pickLeague = (ref: LeagueSoundRef) => {
      clearErrors();
      void api.setEmoteLeagueSound(c.id, ref).then(() => api.previewEmote(c.id)); // plays it once with the new sound
    };
    const submenu = (label: string, items: { ref: LeagueSoundRef; name: string }[]): ReactNode => (
      <Menu checkedValues={checked}>
        <MenuTrigger disableButtonEnhancement><MenuItem>{label}</MenuItem></MenuTrigger>
        <MenuPopover className="soundMenu">
          <MenuList checkedValues={checked}>
            {items.map((i) => (
              <MenuItemRadio key={i.ref} name="sound" value={i.ref} onClick={() => pickLeague(i.ref)}>{i.name}</MenuItemRadio>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    );
    const menu = (
      <MenuList checkedValues={checked}>
        <MenuItemRadio name="sound" value="none" onClick={() => {
          clearErrors();
          void api.setEmoteSound(c.id, null);
        }}>{t.soundNone}</MenuItemRadio>
        <MenuItemRadio name="sound" value="file" onClick={() => {
          soundFor.current = c.id;
          soundPicker.current?.click();
        }}>{t.soundOwnFile}</MenuItemRadio>
        <MenuDivider />
        {submenu(t.soundPings, LEAGUE_SOUNDS.pings.map((p) => ({ ref: p.ref, name: t.pingNames[p.ping] })))}
        {submenu(t.soundEmotes, LEAGUE_SOUNDS.emotes.map((e) => ({ ref: e.ref, name: emoteName(e.slug, t.lang, []) })))}
      </MenuList>
    );
    return { label: t.soundFor(c.name), icon: on ? <Speaker2Regular /> : <SpeakerMuteRegular />, on, menu };
  };

  const pool: PoolItem<EmoteRef>[] = [
    ...EMOTE_CATALOG.map((e) => ({ id: e.slug, icon: emoteIconUrl(e.slug), name: emoteName(e.slug, t.lang, s.customEmotes) })),
    ...s.customEmotes.map((c) => ({
      id: c.id, icon: customStillUrl(customHash(c.id)), name: c.name, tool: soundTool(c),
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
      <input ref={soundPicker} type="file" accept={ACCEPT_SOUND} hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file && soundFor.current) importSound(soundFor.current, file);
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
        <TriggerPicker value={s.emoteTrigger} offOption blocked={[s.trigger, ...(askKey ? [askKey] : [])]}
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
        onFxPick={(id, fx) => void api.setEmoteFx(id, fx)}
        fxIds={s.customEmotes.map((c) => c.id)}
        fxFor={(id) => s.customEmotes.find((c) => c.id === id)?.fx}
        defaults={{ wheel: DEFAULT_EMOTE_WHEEL, center: DEFAULT_CLICK_EMOTE }}
        labels={{ title: t.emoteWheelTitle, desc: t.emoteWheelDesc(key), poolTitle: t.allEmotes, poolDesc: t.allEmotesDesc }}
        onChange={(patch) => void update(emotePatch(patch))} onPreview={(ref) => void api.previewEmote(ref)} />
    </>
  );
}
