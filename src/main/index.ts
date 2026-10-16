import { app } from 'electron';
import { join } from 'node:path';
import { resolveLang, strings, type Strings } from '../shared/i18n';
import { SETTINGS_CH, type About, type AppStatus } from '../shared/ipc';
import { hotkeyLabel } from '../shared/keys';
import { configCommand, type HelperStatus } from '../shared/protocol';
import { overlaySettings, type Settings } from '../shared/settings';
import { registerAppScheme, serveRenderer } from './appProtocol';
import { InputBridge } from './inputBridge';
import { OverlayManager } from './overlayManager';
import { assetPath, helperExePath, PLATFORM, settingsDir } from './paths';
import { registerSettingsIpc } from './settingsIpc';
import { SettingsStore } from './settingsStore';
import { onSettingsWindowGone, openSettingsWindow, settingsWindow } from './settingsWindow';
import { AppTray, type TrayMode } from './tray';

registerAppScheme();
app.setAppUserModelId('com.lolping.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());
  void app.whenReady().then(start);
}

function start(): void {
  if (!process.env.ELECTRON_RENDERER_URL) serveRenderer(join(__dirname, '../renderer'));
  const store = new SettingsStore(settingsDir(), undefined, PLATFORM);
  let settings = store.load();
  // The language setting, or the system display language when it's 'auto'.
  const text = (): Strings => strings(resolveLang(settings.language, app.getLocale()), PLATFORM);
  let enabled = settings.enabledOnStart;
  let quitting = false; // read by pushStatus: once true, the tray and overlays are gone
  let capturing = false; // the settings page is listening for a key, so the helper must stay suspended

  const overlays = new OverlayManager(overlaySettings(settings));
  overlays.start();
  const bridge = new InputBridge({ command: helperExePath() });

  const startHelper = (): void => bridge.retry();

  const status = (): AppStatus => ({ enabled, helper: bridge.status });
  const trayMode = (): TrayMode => {
    const h = bridge.status;
    if (h === 'failed') return 'failed';
    return enabled ? 'on' : 'off';
  };
  const tray = new AppTray(assetPath('textures', 'generic_ping.png'), {
    openSettings: () => openSettingsWindow(),
    setEnabled: (on) => setEnabled(on),
    retryHelper: startHelper,
    quit: () => app.quit(),
  }, text());
  function pushStatus(): void {
    if (quitting) return;
    tray.set(trayMode(), enabled);
    settingsWindow()?.webContents.send(SETTINGS_CH.statusChanged, status());
  }
  const about = (): About => ({
    version: app.getVersion(),
    problems: [...store.problems, ...[...overlays.missingAssets].map((a) => text().missingAsset(a))],
    limitations: text().limitations,
  });

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    bridge.send(configCommand(store.get(), enabled)); // also refreshes the config re-sent after restarts
    const t = text();
    overlays.toast(on ? t.toastOn : t.toastOff, t.toastToggleHint(hotkeyLabel(store.get().toggleHotkey, PLATFORM)));
    pushStatus();
  }

  bridge.on('event', (ev) => {
    if (ev.type === 'toggled') setEnabled(ev.enabled);
    else if (ev.type === 'ready') {
      // A restarted helper starts unsuspended: re-apply an active key capture.
      if (capturing) bridge.send({ type: 'suspend', on: true });
    } else if (ev.type === 'error') console.warn('[helper]', ev.code ?? '', ev.message);
    else overlays.handle(ev);
  });
  bridge.on('status', (s: HelperStatus) => {
    // A helper that is starting or has stopped can no longer send the cancel that dismisses a wheel left on screen.
    if (s !== 'running') overlays.cancelWheel();
    pushStatus();
    if (s === 'failed') overlays.toast(text().toastHelperStopped, text().toastHelperStoppedBody);
  });
  bridge.on('log', (line: string) => console.log('[helper]', line));

  store.on('change', (s: Settings) => {
    const previous = settings;
    settings = s;
    bridge.send(configCommand(s, enabled));
    overlays.updateSettings(overlaySettings(s));
    settingsWindow()?.webContents.send(SETTINGS_CH.changed, s);
    if (s.language !== previous.language) tray.setText(text());
    if (app.isPackaged && s.launchAtStartup !== previous.launchAtStartup) {
      app.setLoginItemSettings({ openAtLogin: s.launchAtStartup, args: ['--hidden'] });
    }
  });

  registerSettingsIpc({
    store,
    getStatus: status,
    setEnabled,
    preview: (id) => overlays.previewPing(id),
    about,
    retryHelper: startHelper,
    setCapturing: (on) => {
      capturing = on;
      bridge.send({ type: 'suspend', on });
    },
    text,
    platform: PLATFORM,
  });
  // The page can't report that it went away mid-capture (window closed, renderer crashed): release the suspend here.
  onSettingsWindowGone(() => {
    if (!capturing) return;
    capturing = false;
    bridge.send({ type: 'suspend', on: false });
  });

  bridge.send(configCommand(settings, enabled));
  bridge.start();
  pushStatus();
  if (!process.argv.includes('--hidden')) {
    openSettingsWindow();
  }

  app.on('window-all-closed', () => {
    /* stay running: the overlays are the app */
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    tray.destroy();
    overlays.destroy();
    void Promise.allSettled([bridge.stop(), store.flush()]).then(() => app.exit(0));
  });
}
