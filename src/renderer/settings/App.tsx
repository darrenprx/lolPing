import { Dropdown, FluentProvider, motionTokens, Option, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import {
  ArrowMove24Regular, ArrowSync24Regular, CursorClick24Regular, DataPie24Regular, Games24Regular, Info24Regular, Keyboard24Regular, MusicNote224Regular, Pin24Regular,
  Power24Regular, ResizeLarge24Regular, Rocket24Regular, Settings24Regular, Speaker224Regular, SpeakerMute24Regular,
  Apps24Regular, Timer24Regular, Cursor24Regular, Emoji24Regular, LocalLanguage24Regular, PeopleCommunity24Regular,
  Sparkle24Regular,
} from '@fluentui/react-icons';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LANGUAGE_NAMES, LANGUAGE_PREFS, resolveLang, strings, type LanguagePref, type Strings } from '../../shared/i18n';
import type { AppStatus } from '../../shared/ipc';
import { featureOn, type FeatureId } from '../../shared/features';
import { hotkeyParts } from '../../shared/keys';
import { ALL_PINGS, DEFAULT_CLICK_PING, DEFAULT_WHEEL, LOGO_TEXTURE, textureUrl, type PingId } from '../../shared/pings';
import { separateAskKey, triggerLabel, type Settings } from '../../shared/settings';
import type { WheelPatch } from '../../shared/wheelLayout';
import { api } from './api';
import { AboutSection } from './components/AboutSection';
import { EmoteSection } from './components/EmoteSection';
import { FeaturesSection } from './components/FeaturesSection';
import { KeyCapture } from './components/KeyCapture';
import { PermissionCard } from './components/PermissionCard';
import { RoomSection } from './components/RoomSection';
import { SettingRow, SliderRow, SwitchRow } from './components/rows';
import { SkipApps } from './components/SkipApps';
import { StatusCard } from './components/StatusCard';
import { TeammateSection } from './components/TeammateSection';
import { TriggerPicker } from './components/TriggerPicker';
import { WheelEditor, type PoolItem } from './components/WheelEditor';
import { TextContext, useText } from './text';
import { macDarkTheme, macLightTheme } from './macTheme';
import { barFrames } from './navIndicator';
import { useAppState, type Update } from './useAppState';
import { useUpdateState } from './useUpdateState';

const PLATFORM = api.platform;
const MAC = PLATFORM === 'mac';
/** macOS measures the screen in points. */
const LENGTH_UNIT = MAC ? 'pt' : 'px';

const SECTIONS: { id: string; label: (t: Strings) => string; icon: ReactNode; feature?: FeatureId }[] = [
  { id: 'trigger', label: (t) => t.navTrigger, icon: <Cursor24Regular /> },
  { id: 'toggle', label: (t) => t.navToggle, icon: <Keyboard24Regular /> },
  { id: 'pings', label: (t) => t.navPings, icon: <Speaker224Regular /> },
  { id: 'wheel', label: (t) => t.navWheel, icon: <DataPie24Regular /> },
  { id: 'emotes', label: (t) => t.navEmotes, icon: <Emoji24Regular />, feature: 'emotes' },
  { id: 'room', label: (t) => t.navRoom, icon: <PeopleCommunity24Regular />, feature: 'rooms' },
  { id: 'teammate', label: (t) => t.navTeammate, icon: <Sparkle24Regular />, feature: 'teammate' },
  { id: 'features', label: (t) => t.navFeatures, icon: <Apps24Regular /> },
  { id: 'app', label: (t) => t.navApp, icon: <Settings24Regular /> },
];

/** The nav selection bar's height; it sits centred on the item. */
const BAR_PX = 16;
/** How long the page's first rows keep their staggered entrance before later rows just rise in. */
const ENTRANCE_MS = 900;

/** Pings that aren't in League's default wheel layout get a "new" badge. */
const NEW_PINGS = new Set<PingId>(['bait', 'visioncleared', 'missingflip']);

/** The settings change for a ping wheel edit: only the fields it touches, since an undefined field would reset that setting. */
function pingPatch(p: WheelPatch<PingId>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  if (p.wheel) patch.wheel = p.wheel;
  if (p.center) patch.clickPingId = p.center;
  return patch;
}

function useDarkMode(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const onChange = () => setDark(m.matches);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);
  return dark;
}

export function App() {
  const dark = useDarkMode();
  const { settings, status, update } = useAppState();
  useEffect(() => {
    document.documentElement.dataset.platform = PLATFORM; // mac.css restyles the page for macOS
  }, []);
  const theme = MAC ? (dark ? macDarkTheme : macLightTheme) : dark ? webDarkTheme : webLightTheme;
  return (
    <FluentProvider theme={theme} style={{ background: 'transparent', height: '100%' }}>
      {settings && status ? (
        <TextContext.Provider value={strings(resolveLang(settings.language, navigator.language), PLATFORM)}>
          <SettingsPage settings={settings} status={status} update={update} />
        </TextContext.Provider>
      ) : null}
    </FluentProvider>
  );
}

function SettingsPage({ settings: s, status, update }: { settings: Settings; status: AppStatus; update: Update }) {
  const t = useText();
  useEffect(() => {
    document.documentElement.lang = t.lang; // picks the right CJK glyphs
  }, [t]);
  const mainRef = useRef<HTMLElement>(null);
  const updateState = useUpdateState() ?? null; // no update checker in this build, or not known yet: no update controls
  const [active, setActive] = useState(SECTIONS[0].id);
  const sections = SECTIONS.filter((sec) => !sec.feature || featureOn(s, sec.feature));
  const off = !status.enabled || status.helper === 'failed';
  const trigger = triggerLabel(s.trigger, t.lang, PLATFORM);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const askKey = separateAskKey(s); // the key pickers can't take it; main refuses it too
  const mouseTrigger = s.trigger === 'mouse4' || s.trigger === 'mouse5';
  const customTrigger = typeof s.trigger === 'object';
  const pingPool: PoolItem<PingId>[] = ALL_PINGS.map((p) => ({
    id: p.id, icon: textureUrl(p.icon), name: t.pingNames[p.id], badge: NEW_PINGS.has(p.id) ? t.wheelNew : undefined,
  }));

  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), ENTRANCE_MS);
    return () => clearTimeout(timer);
  }, []);

  // A jump from the nav selects its item at once; the scroll spy waits until the smooth scroll has ended.
  const jumping = useRef(false);
  const show = (id: string) => {
    const main = mainRef.current;
    const el = document.getElementById(id);
    if (!main || !el) return;
    const max = main.scrollHeight - main.clientHeight;
    const target = Math.min(max, el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop);
    jumping.current = Math.abs(target - main.scrollTop) > 1;
    if (sections.some((sec) => sec.id === id)) setActive(id);
    el.scrollIntoView({ behavior: 'smooth' });
  };
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    const initial = location.hash.slice(1);
    if (initial) requestAnimationFrame(() => showRef.current(initial));
    return api.onShowSection((id) => showRef.current(id));
  }, []);

  const navRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const barTop = useRef<number | null>(null);
  const navIds = sections.map((sec) => sec.id).join();
  useLayoutEffect(() => {
    const item = navRef.current?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    const bar = barRef.current;
    if (!item || !bar) return;
    const top = item.offsetTop + (item.offsetHeight - BAR_PX) / 2;
    const from = barTop.current;
    barTop.current = top;
    bar.style.top = `${top}px`;
    if (from === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    bar.animate(barFrames(from, top, BAR_PX), { duration: motionTokens.durationSlow, easing: motionTokens.curveDecelerateMid });
  }, [active, navIds]);

  const onScroll = () => {
    const main = mainRef.current;
    if (!main || jumping.current) return;
    let current = sections[0].id;
    for (const sec of sections) {
      const el = document.getElementById(sec.id);
      if (el && el.offsetTop - main.offsetTop - 40 <= main.scrollTop) current = sec.id;
    }
    setActive(current);
  };

  return (
    <div className={`app${entering ? ' entering' : ''}`}>
      <div className="titlebar">
        <img src={textureUrl(LOGO_TEXTURE)} alt="" />
        lolPing
      </div>
      <nav className="side" ref={navRef}>
        <span className="navBar" ref={barRef} />
        <div className="brand">
          <img src={textureUrl('pingwheel_basicpingrender')} alt="" />
          <div>
            <b>lolPing</b>
            <span className="desc">{t.tagline}</span>
          </div>
        </div>
        {sections.map((sec) => (
          <button key={sec.id} data-section={sec.id} className={`navItem${active === sec.id ? ' sel' : ''}`} onClick={() => show(sec.id)}>
            {sec.icon}
            {sec.label(t)}
          </button>
        ))}
      </nav>
      <main className="content" ref={mainRef} onScroll={onScroll} onScrollEnd={() => {
        jumping.current = false;
      }}>
        <h1 className="pageTitle">{t.pageTitle}</h1>
        {MAC && status.helper === 'noAccess' ? <PermissionCard stale={status.staleAccess === true} /> : null}
        <StatusCard settings={s} status={status} />

        <div className="section" id="trigger">{t.navTrigger}</div>
        <SettingRow icon={<Cursor24Regular />} title={t.triggerKey} dim={off}
          description={(
            <>
              {mouseTrigger ? t.triggerMouseDesc : t.triggerKeyDesc}
              {customTrigger ? <span className="desc">{t.customKeyNote}</span> : null}
            </>
          )}>
          <TriggerPicker value={s.trigger} blocked={[s.emoteTrigger, ...(askKey ? [askKey] : [])]}
            onChange={(k) => {
              if (k !== 'off') void update({ trigger: k }).then((r) => setTriggerError(r.ok ? null : r.error));
            }} />
        </SettingRow>
        {triggerError ? <div className="rowError" role="alert">{triggerError}</div> : null}
        <SliderRow limit="dragThresholdPx" icon={<ArrowMove24Regular />} title={t.dragDistance} description={t.dragDistanceDesc}
          value={s.dragThresholdPx} format={(v) => `${v} ${LENGTH_UNIT}`} onChange={(v) => void update({ dragThresholdPx: v })} dim={off} />
        <SwitchRow icon={<CursorClick24Regular />} title={t.clickPing(trigger)}
          description={t.clickPingDesc(trigger)}
          checked={s.clickPing} onChange={(v) => void update({ clickPing: v })} dim={off} />
        {PLATFORM === 'win' && ( // only the Windows helper has a fullscreen probe
          <SwitchRow icon={<Games24Regular />} title={t.gameCheck}
            description={t.gameCheckDesc}
            checked={s.gameCheck} onChange={(v) => void update({ gameCheck: v })} dim={off} />
        )}
        <SkipApps apps={s.skipApps} dim={off} update={update} />

        <div className="section" id="toggle">{t.navToggle}</div>
        <SettingRow icon={<Keyboard24Regular />} title={t.toggleShortcut} description={t.toggleShortcutDesc}>
          <KeyCapture
            parts={hotkeyParts(s.toggleHotkey, PLATFORM)}
            requireModifier
            error={hotkeyError}
            onCapture={async (c) => {
              const result = await update({ toggleHotkey: c });
              setHotkeyError(result.ok ? null : result.error);
            }}
          />
        </SettingRow>
        <SwitchRow icon={<Power24Regular />} title={t.startEnabled} description={t.startEnabledDesc}
          checked={s.enabledOnStart} onChange={(v) => void update({ enabledOnStart: v })} />

        <div className="section" id="pings">{t.navPings}</div>
        <SliderRow limit="pingSizePx" icon={<ResizeLarge24Regular />} title={t.pingSize} value={s.pingSizePx}
          format={(v) => `${v} ${LENGTH_UNIT}`} onChange={(v) => void update({ pingSizePx: v })} />
        <SliderRow limit="pingDurationS" icon={<Timer24Regular />} title={t.pingDuration} description={t.pingDurationDesc}
          value={s.pingDurationS} format={(v) => `${v.toFixed(1)} s`} onChange={(v) => void update({ pingDurationS: v })} />
        <SwitchRow icon={<Pin24Regular />} title={t.keepLastPing} description={t.keepLastPingDesc}
          checked={s.keepLastPing} onChange={(v) => void update({ keepLastPing: v })} />
        <SliderRow limit="volume" icon={<Speaker224Regular />} title={t.volume} value={s.volume}
          format={(v) => `${v}`} onChange={(v) => void update({ volume: v })} dim={s.muted} />
        <SwitchRow icon={<SpeakerMute24Regular />} title={t.mute} checked={s.muted} onChange={(v) => void update({ muted: v })} />
        <SwitchRow icon={<MusicNote224Regular />} title={t.tickSound} description={t.tickSoundDesc}
          checked={s.tickSound} onChange={(v) => void update({ tickSound: v })} />

        <div className="section" id="wheel">{t.navWheel}</div>
        <SliderRow limit="wheelSizePx" icon={<ResizeLarge24Regular />} title={t.wheelSize} description={t.wheelSizeDesc}
          value={s.wheelSizePx} format={(v) => `${v} ${LENGTH_UNIT}`} onChange={(v) => void update({ wheelSizePx: v })} />
        <WheelEditor wheel={s.wheel} center={s.clickPingId} centerOn={s.clickPing} trigger={trigger} pool={pingPool}
          defaults={{ wheel: DEFAULT_WHEEL, center: DEFAULT_CLICK_PING }}
          labels={{ title: t.wheelTitle, desc: t.wheelDesc(trigger), poolTitle: t.allPings, poolDesc: t.allPingsDesc }}
          onChange={(patch) => void update(pingPatch(patch))} onPreview={(id) => void api.previewPing(id)} />

        {featureOn(s, 'emotes') ? (
          <>
            <div className="section" id="emotes">{t.navEmotes}</div>
            <EmoteSection settings={s} update={update} lengthUnit={LENGTH_UNIT} />
          </>
        ) : null}

        {featureOn(s, 'rooms') ? (
          <>
            <div className="section" id="room">{t.navRoom}</div>
            <RoomSection settings={s} update={update} />
          </>
        ) : null}

        {featureOn(s, 'teammate') ? (
          <>
            <div className="section" id="teammate">{t.navTeammate}</div>
            <TeammateSection settings={s} update={update} />
          </>
        ) : null}

        <div className="section" id="features">{t.navFeatures}</div>
        <FeaturesSection settings={s} update={update} />

        <div className="section" id="app">{t.navApp}</div>
        <SwitchRow icon={<Rocket24Regular />} title={t.launchAtStartup} description={t.launchAtStartupDesc}
          checked={s.launchAtStartup} onChange={(v) => void update({ launchAtStartup: v })} />
        <SettingRow icon={<LocalLanguage24Regular />} title={t.language} description={t.languageDesc}>
          <Dropdown
            style={{ minWidth: 170 }}
            value={s.language === 'auto' ? t.languageAuto : LANGUAGE_NAMES[s.language]}
            selectedOptions={[s.language]}
            onOptionSelect={(_, d) => void update({ language: d.optionValue as LanguagePref })}
          >
            {LANGUAGE_PREFS.map((pref) => (
              <Option key={pref} value={pref} text={pref === 'auto' ? t.languageAuto : LANGUAGE_NAMES[pref]}>
                {pref === 'auto' ? t.languageAuto : LANGUAGE_NAMES[pref]}
              </Option>
            ))}
          </Dropdown>
        </SettingRow>
        {updateState ? (
          <SwitchRow icon={<ArrowSync24Regular />} title={t.autoUpdateCheck} description={t.autoUpdateCheckDesc}
            checked={s.autoUpdateCheck} onChange={(v) => void update({ autoUpdateCheck: v })} />
        ) : null}
        <AboutSection icon={<Info24Regular />} update={updateState} />
      </main>
    </div>
  );
}
