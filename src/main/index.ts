import {
  app, clipboard, ClipboardItem, dialog, Menu, nativeImage, powerMonitor, safeStorage, screen, shell, systemPreferences,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { resolveLang, strings, type Strings } from '../shared/i18n';
import {
  SETTINGS_CH, type About, type AppStatus, type PanelAction, type PanelState, type TeammateHistoryOp,
} from '../shared/ipc';
import { announcedEmoteHashes } from '../shared/emotes';
import { featureOn, liveKeys, roomFeaturesOff } from '../shared/features';
import { hotkeyLabel } from '../shared/keys';
import { LOGO_TEXTURE } from '../shared/pings';
import { configCommand, type HelperStatus } from '../shared/protocol';
import type { RoomState } from '../shared/room';
import type { VoteKind } from '../shared/roomProtocol';
import { formatRoomCode, parseRoomCode } from '../shared/roomCode';
import { sameTagRgb, tagWire } from '../shared/roomColors';
import { askKeyHeld, asksOnPing, overlaySettings, soundLevel, type Settings } from '../shared/settings';
import type { Spot } from '../shared/teammate/askMachine';
import { rememberApp } from '../shared/teammate/appRules';
import type { ThreadRecord } from '../shared/teammate/history';
import { openInRows, resumableProfile, resumeArgs } from '../shared/teammate/agentProfiles';
import { wordsContinuesByDefault } from '../shared/teammate/threads';
import type { HistoryState, MateAction, MateView } from '../shared/teammateIpc';
import { parseTextInput } from '../shared/textCommands';
import { updateErrorText, type UpdateState } from '../shared/update';
import { registerAppScheme, serveAppScheme } from './appProtocol';
import { resolveTarget, toShared } from './displayNumbers';
import { EmoteCache } from './emoteCache';
import { EmoteLibrary, resolveEmoteArt } from './emoteLibrary';
import { EmoteTransfer } from './emoteTransfer';
import { isFile } from './fileState';
import { InputBridge } from './inputBridge';
import { LanTransport } from './lanTransport';
import { RELAYS } from './relays';
import { RelayTransport } from './relayTransport';
import { OverlayManager, type AskClick, type AskRelease, type SharedEmote, type SharedPing } from './overlayManager';
import {
  assetPath, buildResourcePath, contextHelperPath, helperExePath, IS_LINUX, IS_MAC, PLATFORM, settingsDir,
} from './paths';
import { deriveRoomKeys } from './roomCrypto';
import { RoomHistory } from './roomHistory';
import { PanelWindows } from './panelWindows';
import { MAX_MEMBERS, RoomManager, type RoomToast } from './roomManager';
import { postLine, startRoomText, type RoomTextDeps } from './roomText';
import { RoomVotes, voteResultLine } from './roomVotes';
import { registerSettingsIpc } from './settingsIpc';
import { SettingsStore } from './settingsStore';
import { bridgeCommand, userConfigSnippet } from './mcp/bridgeCommand';
import { BridgeServer, bridgeLocation, bridgePath, writeTokenFile } from './mcp/bridgeServer';
import { ActionRunner } from './teammate/actions';
import { captureOutput, checkAgent } from './teammate/agents/check';
import { findExecutable, userPath, withPath } from './teammate/agents/command';
import { launchTerminal } from './teammate/agents/openInTerminal';
import { AgentRunner, isExecutable, killProcessTree, searchPath } from './teammate/agents/runner';
import { AskController, bridgeHandler } from './teammate/askController';
import { AskGesture } from './teammate/askGesture';
import { ContextClient } from './teammate/contextClient';
import { installedEditors } from './teammate/editors';
import { fetchWebPdf, pdfAssetDirs, readDocument, readPdfBuffer } from './teammate/files';
import { HistoryStore } from './teammate/historyStore';
import { MateWindows, overShownWindow } from './teammate/mateWindows';
import { createAdapter } from './teammate/providers';
import { SecretStore } from './teammate/secrets';
import { StaleWatcher } from './teammate/staleWatcher';
import { UsageLog } from './teammate/usage';
import { onSettingsWindowGone, openSettingsWindow, settingsWindow } from './settingsWindow';
import { closeTextWindow, onTextWindowGone, openTextWindow, registerTextWindow, textWindow } from './textWindow';
import { AppTray, trayUpdateFrom, type TrayMode } from './tray';
import { trayUpdateHandlers } from './trayUpdate';
import { MacBackend, RELEASES_API } from './updateMac';
import { WinBackend } from './updateWin';
import { Updater } from './updater';
import { setLinuxAutostart } from './linuxAutostart';
import { RoomShotsRuntime } from './roomShotsRuntime';
import { writeDiagnostic } from './diagnostics';
import { failStartup, startupComplete } from './startupDiagnostics';
import { rememberRoomJoins } from './savedRooms';

const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
/** How many foreground app names the rules card is offered. */
const RECENT_APPS_MAX = 20;
const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

// X11 uses root-window pixels. Keep Electron in the same coordinate space on every monitor.
if (IS_LINUX) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

registerAppScheme();
app.setAppUserModelId('com.lolping.app');

if (!app.requestSingleInstanceLock()) {
  writeDiagnostic('second-instance-exit');
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());
  app.on('activate', () => openSettingsWindow()); // macOS: opened again from Finder or Launchpad while running
  void app.whenReady().then(start).catch(failStartup);
}

/** The OS account name: the default name under this machine's pings in a room. */
function osUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return 'Player';
  }
}

/**
 * The relays to use. Development builds take a comma-separated LOLPING_RELAYS instead, so "no relay reachable" can
 * be tried without touching the firewall; packaged builds always use the pinned list.
 */
function relayUrls(): readonly string[] {
  const custom = app.isPackaged ? undefined : process.env.LOLPING_RELAYS;
  const urls = custom?.split(',').map((u) => u.trim()).filter((u) => u.startsWith('wss://')) ?? [];
  return urls.length > 0 ? urls : RELAYS;
}

/** History keeps a 512 px JPEG of each ask's screen. */
const THUMB_PX = 512;

function thumbnail(jpeg: Buffer): string {
  const img = nativeImage.createFromBuffer(jpeg);
  if (img.isEmpty()) return '';
  const { width, height } = img.getSize();
  const scale = Math.min(1, THUMB_PX / Math.max(width, height));
  const small = scale < 1
    ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
    : img;
  return small.toJPEG(80).toString('base64');
}

/** The cursor in the helper's physical pixels: DIPs on macOS and Linux, where the overlays map them 1:1. */
function cursorPhys(): { x: number; y: number } {
  const p = screen.getCursorScreenPoint();
  return IS_MAC || IS_LINUX ? p : screen.dipToScreenPoint(p);
}

/** The teammate's parts. They exist only while the feature is on. */
interface Mate {
  secrets: SecretStore;
  history: HistoryStore;
  usage: UsageLog;
  context: ContextClient;
  windows: MateWindows;
  actions: ActionRunner;
  controller: AskController;
  /** Fades the teammate's marks when the page under them moves. */
  stale: StaleWatcher;
  agents: AgentRunner;
  /** lolPing's end of the MCP bridge once it listens; null when it couldn't, and then agent asks ask for a restart. */
  mcp: Promise<BridgeServer | null>;
}

/** Runs `cmd` and gives its stdout, for the login shell's PATH on macOS. */
function runForOutput(cmd: string, args: string[], ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: ms, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** What a bridge started by the user's own app needs; the same inputs the bridge server and the agent runner use. */
function userBridgeInputs(): { execPath: string; bridgeJs: string; pipe: string; dataDir: string } | null {
  try {
    const userData = app.getPath('userData');
    return {
      execPath: process.execPath, bridgeJs: join(__dirname, 'bridge.js'),
      pipe: bridgePath(PLATFORM, userData, userInfo().username), dataDir: userData,
    };
  } catch {
    return null; // userInfo() throws when the account has no name
  }
}

/** lolPing's environment with the user's PATH (a login shell's on macOS): where an agent or an editor is looked for. */
async function userEnv(): Promise<NodeJS.ProcessEnv> {
  return withPath(process.env, await userPath(PLATFORM, runForOutput), PLATFORM);
}

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** macOS: the app, Edit and Window menus, so Cmd+Q, Cmd+W and the clipboard shortcuts work in the settings window. */
function setMacMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}

function start(): void {
  writeDiagnostic('startup-initialize');
  const library = new EmoteLibrary(join(settingsDir(), 'emotes'));
  const cache = new EmoteCache(join(settingsDir(), 'emote-cache'), Date.now);
  void cache.present();
  serveAppScheme({
    rendererRoot: process.env.ELECTRON_RENDERER_URL ? null : join(__dirname, '../renderer'), // development pages come from Vite
    emoteDirs: () => [library.dir, cache.dir], // the library wins; the cache only fills the gaps
  });
  if (IS_MAC) {
    app.dock?.hide(); // a menu bar app: the Dock icon only shows while settings are open
    setMacMenu();
  }
  const store = new SettingsStore(settingsDir(), undefined, PLATFORM, { name: osUserName(), color: randomInt(8) });
  let settings = store.load();
  writeDiagnostic('settings-loaded', { firstRun: store.firstRun, problems: store.problems.length });
  // An imported emote whose still is gone is dropped; normalising the shorter list repairs the wheel slots that used it.
  const kept = library.present(settings.customEmotes);
  if (kept.length !== settings.customEmotes.length) settings = store.update({ customEmotes: kept });
  // The language setting, or the system display language when it's 'auto'.
  const text = (): Strings => strings(resolveLang(settings.language, app.getLocale()), PLATFORM);
  let enabled = settings.enabledOnStart;
  let quitting = false; // read by pushStatus: once true, the tray and overlays are gone
  let capturing = false; // the settings page is listening for a key, so the helper must stay suspended
  let textOpen = false;
  let wordsOpen = false; // the teammate's words box has the keyboard: the helper stays suspended, as for the text box
  let mate: Mate | null = null; // the teammate, while its feature is on
  let roomShots: RoomShotsRuntime | null = null;
  let mateFailed = false; // it couldn't start: its ask key stays off for this session
  /** The settings as the helper and overlays use them: without the teammate once it failed to start. */
  const effective = (s: Settings): Settings => (mateFailed ? { ...s, features: { ...s.features, teammate: false } } : s);

  const overlays = new OverlayManager(
    overlaySettings(settings, resolveLang(settings.language, app.getLocale())),
    (ref, remote) =>
      resolveEmoteArt(ref, settings.customEmotes, remote, (hash) => {
        if (!settings.friendEmotes || !cache.has(hash)) return false; // off: friends' images show as the placeholder
        cache.touch(hash); // a shown still is the most recently used at the next cache sweep
        return true;
      }),
  );
  overlays.start();
  writeDiagnostic('overlays-initialized');
  const bridge = new InputBridge({ command: helperExePath() });
  const staleOwners = new Set<string>();
  const staleWatch = (owner: string, on: boolean): void => {
    if (on) staleOwners.add(owner); else staleOwners.delete(owner);
    bridge.send({ type: 'staleWatch', on: staleOwners.size > 0 });
  };

  // Updates: only in an installed build, or in a development build pointed at a test server with LOLPING_UPDATE_TEST_URL.
  const testUrl = process.env.LOLPING_UPDATE_TEST_URL || undefined;
  // Linux packages are updated manually until a Linux release feed is published.
  const updater = !IS_LINUX && (app.isPackaged || testUrl) ? createUpdater() : null;
  function createUpdater(): Updater {
    const backend = IS_MAC
      ? new MacBackend({
        apiBase: testUrl ?? RELEASES_API,
        currentVersion: app.getVersion(),
        fetch,
        downloadsDir: app.getPath('downloads'),
        focus: () => app.focus({ steal: true }), // the dialog is shown from a menu bar app, which is not the active one
        showDialog: (message) => dialog.showMessageBox({ message, buttons: ['OK'] }).then(() => undefined),
        openPath: (path) => shell.openPath(path),
        dialogText: () => text().updateMacDialog,
        quit: () => app.quit(),
      })
      : new WinBackend({
        testUrl,
        log: (line) => console.log('[update]', line),
        toast: () => overlays.toast(text().restartingToUpdate, ''),
        isQuitting: () => quitting,
      });
    return new Updater({
      backend,
      now: Date.now,
      autoCheck: () => settings.autoUpdateCheck,
      notifiedVersion: () => settings.updateNotifiedVersion,
      setNotifiedVersion: (version) => void store.update({ updateNotifiedVersion: version }),
      errorText: (kind, reason) => {
        console.warn('[update]', kind, reason); // the whole reason goes to the log; the card shows its first line
        return updateErrorText(text(), kind, reason);
      },
    });
  }

  // Room: pings shared with other lolPing users, on the network and through public relays.
  const lan = new LanTransport();
  const relay = new RelayTransport({ urls: relayUrls() });
  const room = new RoomManager({
    transports: [lan, relay],
    now: Date.now,
    randomBytes: (n) => randomBytes(n),
    deriveKeys: deriveRoomKeys,
    appVersion: app.getVersion(),
    profile: () => ({
      name: settings.displayName, ...tagWire(settings.tagColor, settings.tagColorCustom), limit: settings.incomingPingLimit,
      nf: roomFeaturesOff(settings),
      ...(PLATFORM === 'win' ? { shots: featureOn(settings, 'rooms'), receiveShots: settings.roomShots.receive,
        markerLimits: settings.roomShots } : {}),
    }),
    resolveTarget: (d) => {
      const target = resolveTarget(overlays.numbered(), d);
      return target ? { displayId: target.id, width: target.bounds.width, height: target.bounds.height } : null;
    },
    // With emotes switched off we announce none, so friends don't send stills for emotes we won't use.
    announceEmotes: () => (featureOn(settings, 'emotes') ? announcedEmoteHashes(settings.emoteWheel, settings.clickEmoteId) : []),
  });
  // Custom emote stills travel both ways: this side asks for friends' hashes and answers wants for our own.
  const transfer = new EmoteTransfer({
    now: Date.now,
    enabled: () => settings.friendEmotes && featureOn(settings, 'emotes'),
    have: (hash) => isFile(join(library.dir, `${hash}.webp`), false) || cache.has(hash),
    still: (hash) => {
      try {
        return new Uint8Array(readFileSync(join(library.dir, `${hash}.webp`)));
      } catch {
        return null;
      }
    },
    announced: () => announcedEmoteHashes(settings.emoteWheel, settings.clickEmoteId),
    put: (hash, bytes) => void cache.put(hash, bytes),
    routeOf: (peer) => room.routeKind(peer),
    sendToLan: (peer, body) => room.sendToLan(peer, body),
    broadcastShared: (body) => room.broadcastShared(body),
    spareSharedToken: (keep) => room.spareSharedToken(keep),
  });
  room.on('emotes', (peer: string, hashes: string[]) => transfer.announced(peer, hashes));
  room.on('want', (w: Parameters<EmoteTransfer['onWant']>[0]) => transfer.onWant(w));
  room.on('chunk', (c: Parameters<EmoteTransfer['onChunk']>[0]) => transfer.onChunk(c));
  room.on('memberGone', (peer: string) => transfer.memberGone(peer));
  const roomState = (): RoomState => {
    const all = screen.getAllDisplays();
    return {
      ...room.state(),
      displays: overlays.numbered().map((d) => {
        const scale = all.find((x) => x.id === d.id)?.scaleFactor ?? 1; // show pixels, as the OS display settings do
        return { number: d.number, width: Math.round(d.bounds.width * scale), height: Math.round(d.bounds.height * scale), primary: d.primary };
      }),
    };
  };
  const clipboardCode = async (): Promise<string | null> => {
    // Strict: nobody typed this, so only an unmistakable code counts, never words that happen to pass the check.
    const parsed = parseRoomCode(await clipboard.readText().catch(() => ''), { strict: true });
    return parsed.ok ? formatRoomCode(parsed.code) : null;
  };
  const copyRoomCode = (): void => {
    const code = room.state().code;
    if (code) void clipboard.writeText(code).catch(() => undefined);
  };

  // macOS Accessibility. Without it the helper can't create its event tap, so it isn't started: a timer waits for
  // the permission instead. `staleAccess`: macOS lists lolPing as allowed, yet the helper still has no access.
  let accessTimer: NodeJS.Timeout | null = null;
  let staleAccess = false;
  const trusted = (): boolean => !IS_MAC || systemPreferences.isTrustedAccessibilityClient(false);
  const stopWaitingForAccess = (): void => {
    if (accessTimer) clearInterval(accessTimer);
    accessTimer = null;
  };
  const waitForAccess = (): void => {
    if (accessTimer) return;
    accessTimer = setInterval(() => {
      if (!trusted()) return;
      stopWaitingForAccess();
      staleAccess = false;
      bridge.retry();
    }, 1500);
    overlays.cancelWheel();
    pushStatus();
  };
  const startHelper = (): void => {
    staleAccess = false;
    if (trusted()) bridge.retry();
    else waitForAccess();
  };

  const helperStatus = (): HelperStatus => (accessTimer ? 'noAccess' : bridge.status);
  const status = (): AppStatus => ({ enabled, helper: helperStatus(), staleAccess,
    ...(roomShots?.remaining ? { markerCooldownMs: roomShots.remaining } : {}) });
  const trayMode = (): TrayMode => {
    const h = helperStatus();
    if (h === 'failed' || h === 'noAccess') return h;
    return enabled ? 'on' : 'off';
  };
  const tray = new AppTray(
    assetPath('textures', `${LOGO_TEXTURE}.png`),
    {
      openSettings: () => openSettingsWindow(),
      setEnabled: (on) => setEnabled(on),
      retryHelper: startHelper,
      quit: () => app.quit(),
      room: {
        joinClipboard: () => {
          void clipboardCode().then((code) => {
            if (code) void room.join(code);
            else overlays.toast(text().toastNoCode, text().toastNoCodeBody);
          });
        },
        create: () => void room.create(),
        copyCode: copyRoomCode,
        setMuted: (on) => store.update({ roomMuted: on }),
        leave: () => room.leave(),
        openSettings: () => openSettingsWindow('room'),
      },
      teammate: {
        stop: () => mate?.controller.cancel('user'),
        openHistory: () => void openHistory(),
        setHistoryPaused: (paused) => setHistoryPaused(paused),
      },
      // The tray has no card to show a result on, so the handlers toast it. Nothing to toast on once the overlays are gone.
      update: updater
        ? trayUpdateHandlers({ updater, toast: (title, body) => { if (!quitting) overlays.toast(title, body); }, text })
        : { check: () => undefined, start: () => undefined },
    },
    text(),
    IS_MAC ? { on: buildResourcePath('trayTemplate.png'), off: buildResourcePath('trayOffTemplate.png') } : undefined,
  );
  tray.setRoomsShown(featureOn(settings, 'rooms'));
  /** Sends to the settings window if there is one that is still alive (the updater also reports while the app quits). */
  function sendToSettings(channel: string, payload: unknown): void {
    const w = settingsWindow();
    if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
  if (updater) {
    updater.on('state', (s: UpdateState) => {
      if (quitting) return; // the tray and windows are going away
      tray.setUpdate(trayUpdateFrom(s));
      sendToSettings(SETTINGS_CH.updateState, s);
    });
    updater.on('notify', (version: string) => {
      if (!quitting) overlays.toast(text().updateToastTitle, text().updateToastBody(version));
    });
    tray.setUpdate(trayUpdateFrom(updater.state));
  }
  function pushRoom(): void {
    if (quitting) return;
    const s = roomState();
    tray.setRoom({ code: s.code, count: s.members.length, muted: settings.roomMuted });
    settingsWindow()?.webContents.send(SETTINGS_CH.roomChanged, s);
  }
  const syncRoomFlags = (): void => room.setStatusFlags({ paused: !enabled, roomMuted: settings.roomMuted });
  room.on('state', pushRoom);
  // The vote widget and the roster live in their own windows that never take focus.
  const panels = new PanelWindows();
  let captureDepth = 0;
  const excludeCaptures = (on: boolean): void => {
    overlays.setCaptureExcluded(on);
    mate?.windows.setCaptureExcluded(on);
    roomShots?.windows.setCaptureExcluded(on);
    settingsWindow()?.setContentProtection(on);
    textWindow()?.setContentProtection(on);
  };
  const captureLease = (): (() => void) => {
    if (++captureDepth === 1) {
      try { excludeCaptures(true); }
      catch (err) { captureDepth--; excludeCaptures(false); throw err; }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--captureDepth === 0) excludeCaptures(false);
    };
  };
  if (PLATFORM === 'win') roomShots = new RoomShotsRuntime({
    room, overlays, settings: () => settings, enabled: () => enabled, lang: () => resolveLang(settings.language, app.getLocale()),
    lease: captureLease, helperWatch: (on) => staleWatch('shots', on), statusChanged: pushStatus,
    cooldown: (_ms, displayId) => { overlays.markerBlocked(text().shots.blocked, displayId); pushStatus(); },
  });
  // The room keys (Alt+T and the panel key) are the helper's only while a room is active, so they reach other apps otherwise.
  let live = liveKeys(settings, { active: false }, enabled);
  const sendConfig = (): void => {
    live = liveKeys(settings, { active: room.state().phase === 'active' }, enabled);
    // The helper stops reporting a held panel key once it is off, so the roster would stay up: hide it here.
    if (!live.panel) panels.hideRoster();
    bridge.send(configCommand(effective(settings), enabled, live));
  };
  room.on('state', () => {
    const next = liveKeys(settings, { active: room.state().phase === 'active' }, enabled);
    if (next.text !== live.text || next.panel !== live.panel) sendConfig();
  });
  overlays.on('displays', pushRoom);
  room.on('remotePing', (p) => overlays.spawnRemote({ ...p, ...(roomShots?.remote(p) ? { silent: true } : {}) }));
  overlays.on('shared', (p: SharedPing) => {
    const shared = toShared(overlays.numbered(), p.displayId, p.x, p.y);
    if (shared) room.sendPing(p.id, { ...shared, ...(p.batch ? { batch: p.batch } : {}) });
  });
  room.on('remoteEmote', (p) => {
    if (featureOn(settings, 'emotes')) overlays.spawnRemoteEmote({ ...p, ...(roomShots?.remote(p) ? { silent: true } : {}) });
  });
  overlays.on('sharedEmote', (p: SharedEmote) => {
    const shared = toShared(overlays.numbered(), p.displayId, p.x, p.y);
    // The effect rides on the message, so friends see the one its sender picked even before they have the image.
    const fx = settings.customEmotes.find((c) => c.id === p.ref)?.fx;
    if (shared) room.sendEmote(p.ref, { ...shared, ...(p.batch ? { batch: p.batch } : {}) }, fx);
  });
  // This session's room lines: members' text and alive lines while the text feature is on, and our own.
  const history = new RoomHistory(() => refreshRoster());
  const lineDeps: Pick<RoomTextDeps, 'show' | 'history' | 'now'> = {
    show: (p) => overlays.spawnText({ ...p, style: settings.roomTextStyle }),
    history,
    now: Date.now,
  };
  let stopRoomText: (() => void) | null = null;
  const syncRoomText = (): void => {
    const on = featureOn(settings, 'roomText');
    if (on && !stopRoomText) stopRoomText = startRoomText({ room, ...lineDeps, text });
    else if (!on && stopRoomText) {
      stopRoomText();
      stopRoomText = null;
    }
  };
  syncRoomText();
  // Names are kept for the session: a result may name a member who has just left.
  const memberNames = new Map<string, string>();
  room.on('state', () => {
    const s = room.state();
    if (s.phase === 'idle') {
      history.clear();
      memberNames.clear();
      closeTextWindow(); // its text and commands only make sense in a room, and a kick leaves it open otherwise
    }
    for (const m of s.members) memberNames.set(m.peer, m.name);
  });
  const panelState = (view: PanelState['view'], vote: PanelState['vote'], voteOver = false): PanelState => ({
    view, lang: resolveLang(settings.language, app.getLocale()), max: MAX_MEMBERS, room: room.state(), history: history.lines(),
    vote, voteOver, textOn: featureOn(settings, 'roomText'), votesOn: featureOn(settings, 'roomVotes'),
    volume: soundLevel(settings),
  });
  /** An open roster follows the room and its history; a hidden one ignores this. */
  function refreshRoster(): void {
    panels.update(panelState('roster', null));
  }
  room.on('state', refreshRoster);
  panels.on('action', (a: PanelAction) => {
    switch (a.t) {
      case 'ballot':
        roomVotes?.answer(a.yes);
        break;
      case 'alive':
        // The cursor, as the text box does: the page's own screen point is not in DIPs on every display setup.
        sendOwnAlive(a.peer, screen.getCursorScreenPoint());
        break;
      case 'mute':
        room.muteMember(a.peer, a.on);
        break;
      case 'kick':
        startVote('kick', a.peer);
        break;
      case 'vote':
        startVote(a.kind);
        break;
    }
  });
  const startVote = (kind: VoteKind, target?: string): void => {
    if (roomVotes?.start(kind, target) === 'busy') overlays.toast(text().voteBusy, '');
  };
  // Votes run while the feature is on; with it off, members' votes and ballots are ignored here.
  let roomVotes: RoomVotes | null = null;
  const syncRoomVotes = (): void => {
    const on = featureOn(settings, 'roomVotes');
    if (on && !roomVotes) {
      roomVotes = new RoomVotes({
        room,
        now: Date.now,
        randomId: () => randomBytes(4).toString('hex'),
        onView: (v, over) => (v ? panels.showVote(panelState('vote', v, over)) : panels.hideVote()),
        onResult: (o) => {
          const display = screen.getPrimaryDisplay();
          postLine(lineDeps, {
            kind: 'vote', owner: 'vote', tag: null, displayId: display.id, x: display.bounds.width / 2, y: display.bounds.height * 0.2,
            text: voteResultLine(o, (peer) => memberNames.get(peer) ?? '?', text()),
          });
        },
        onKicked: () => {
          room.leave(); // also forgets the room code, so it isn't rejoined at the next start
          overlays.toast(text().kickedYou, '');
        },
      });
    } else if (!on && roomVotes) {
      roomVotes.stop();
      roomVotes = null;
    }
  };
  syncRoomVotes();
  rememberRoomJoins(room, store, Date.now);
  room.on('toast', (n: RoomToast) => {
    const t = text();
    const code = room.state().code ?? '';
    if (n.kind === 'joinedRoom') overlays.toast(t.toastRoomJoined(n.code), t.toastRoomJoinedBody);
    else if (n.kind === 'full') overlays.toast(t.toastRoomFull, t.toastRoomFullBody);
    else if (n.kind === 'joined') overlays.toast(t.toastMemberJoined(n.name), code);
    else if (n.kind === 'left') overlays.toast(t.toastMemberLeft(n.name), code);
    else if (n.kind === 'kicked') overlays.toast(t.toastMemberKicked(n.name), code);
    else overlays.toast(t.toastMemberLost(n.name), code);
  });
  powerMonitor.on('resume', () => {
    lan.rebind();
    relay.wake();
  });

  function pushStatus(): void {
    if (quitting) return;
    tray.setMarkerCooldown(Math.ceil((roomShots?.remaining ?? 0) / 1000));
    tray.set(trayMode(), enabled);
    settingsWindow()?.webContents.send(SETTINGS_CH.statusChanged, status());
  }
  const about = (): About => ({
    version: app.getVersion(),
    problems: [
      ...store.problems,
      ...(store.emoteKeyClashed ? [text().problemEmoteKeyClash] : []),
      ...[...overlays.missingAssets].map((a) => text().missingAsset(a)),
    ],
    limitations: text().limitations,
  });

  const mateLang = () => resolveLang(settings.language, app.getLocale());
  const mateTag = () => {
    const t = settings.teammate;
    return { name: t.tagName, color: t.tagColor, rgb: t.tagColorCustom };
  };
  /** Turns ask-wheel releases into asks; made before the pause, helper and teammate paths that cancel it. */
  const gesture = new AskGesture({
    now: Date.now,
    timer: (ms, fn) => {
      const timer = setTimeout(() => {
        try {
          fn();
        } catch (err) {
          console.warn('[teammate]', err);
        }
      }, ms);
      return () => clearTimeout(timer);
    },
    held: () => askKeyHeld(settings),
    ask: (spots) => mate?.controller.ask(spots),
    prepare: (spots) => mate?.controller.prepare(spots),
    drop: () => mate?.controller.dropPrepared(),
    words: openWords,
    note: (spot, why) => {
      const at = overlays.toLocal(spot.phys);
      if (!at) return;
      const t = strings(mateLang(), PLATFORM).teammate.ask;
      overlays.spawnText({
        ...at, text: why === 'full' ? t.spotsFull : t.spotsDisplay, owner: 'mate', style: settings.roomTextStyle,
        tag: mateTag(),
      });
    },
  });

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    sendConfig(); // also refreshes the config re-sent after restarts
    if (!on) {
      overlays.dropKeptPings();
      mate?.controller.cancel('pause');
      gesture.cancel();
      closeWords();
    }
    const t = text();
    overlays.toast(on ? t.toastOn : t.toastOff, t.toastToggleHint(hotkeyLabel(store.get().toggleHotkey, PLATFORM)));
    syncRoomFlags();
    pushStatus();
  }

  const syncSuspended = (): void => bridge.send({ type: 'suspend', on: capturing || textOpen || wordsOpen });
  /** A screen point (DIPs) as our own lines and the room see it: its display, the point inside it, and the shared form. */
  const ownSpot = (at: { x: number; y: number }) => {
    const display = screen.getDisplayNearestPoint(at);
    const x = at.x - display.bounds.x;
    const y = at.y - display.bounds.y;
    return { displayId: display.id, x, y, shared: toShared(overlays.numbered(), display.id, x, y) };
  };
  const ownTag = () => ({ name: settings.displayName, ...tagWire(settings.tagColor, settings.tagColorCustom) });
  /** Shows our own text where the box was opened, and sends it to the room. */
  const sendOwnText = (message: string, at: { x: number; y: number }): void => {
    const { shared, ...spot } = ownSpot(at);
    postLine(lineDeps, { kind: 'text', owner: 'self', tag: ownTag(), ...spot, text: message });
    if (shared) room.sendText(message, shared);
  };
  /** "<name> - Alive" for the member whose name tag was clicked in the panel, shown here and sent to the room. */
  const sendOwnAlive = (peer: string, at: { x: number; y: number }): void => {
    const who = room.state().members.find((m) => m.peer === peer);
    if (!who || !featureOn(settings, 'roomText')) return;
    const { shared, ...spot } = ownSpot(at);
    postLine(lineDeps, { kind: 'alive', owner: 'self', tag: ownTag(), ...spot, text: text().aliveLine(who.name) });
    if (shared) room.sendAlive(peer, shared);
  };
  registerTextWindow((raw, at) => {
    const input = parseTextInput(raw);
    switch (input.kind) {
      case 'text':
        sendOwnText(input.text, at);
        return 'sent';
      case 'unknown':
        return 'unknown';
      case 'ff':
      case 'ready':
        if (!roomVotes) return 'votesOff';
        // Typing the command of the vote that is open means yes.
        if (roomVotes.current()?.kind === input.kind) roomVotes.answer(true);
        else if (roomVotes.start(input.kind) === 'busy') overlays.toast(text().voteBusy, '');
        return 'sent';
      case 'noff':
        if (!roomVotes) return 'votesOff';
        if (roomVotes.current()?.kind === 'ff') roomVotes.answer(false);
        return 'sent';
      default:
        return 'sent'; // nothing usable was typed: just close
    }
  });
  onTextWindowGone(() => {
    textOpen = false;
    syncSuspended();
  });
  const openText = (): void => {
    if (!live.text || textOpen || capturing) return;
    textOpen = true;
    syncSuspended();
    const t = text();
    try {
      openTextWindow(screen.getCursorScreenPoint(), {
        placeholder: t.textBoxPlaceholder, hint: t.textBoxHint, unknown: t.textBoxUnknown, votesOff: t.textBoxVotesOff,
      });
    } catch (err) {
      // No window will ever close to release the suspend, so release it here.
      console.warn('[text]', err);
      textOpen = false;
      syncSuspended();
    }
  };
  bridge.on('event', (ev) => {
    if (ev.type === 'toggled') setEnabled(ev.enabled);
    else if (ev.type === 'textRequested') openText();
    else if (ev.type === 'panel') {
      if (!ev.show) panels.hideRoster();
      else if (live.panel) panels.showRoster(screen.getCursorScreenPoint(), panelState('roster', null));
    } else if (ev.type === 'ready') {
      // A restarted helper starts unsuspended: re-apply an active key capture.
      if (capturing || textOpen || wordsOpen) syncSuspended();
      panels.hideRoster(); // a restarted helper lost the panel key's up, so a shown roster would stay up
      mate?.stale.helperReady();
      roomShots?.helperReady();
    } else if (ev.type === 'scroll') {
      mate?.stale.scroll({ x: ev.x, y: ev.y });
      roomShots?.scroll({ x: ev.x, y: ev.y });
    }
    else if (ev.type === 'error') console.warn('[helper]', ev.code ?? '', ev.message);
    else if (ev.type === 'triggerUp') {
      // Only the key that asks sends the spots held so far; the emote key's up, or the ping key's outside it, doesn't.
      if (ev.wheel === 'ask' || (ev.wheel === 'ping' && asksOnPing(settings))) gesture.keyUp();
    } else overlays.handle(ev);
  });
  bridge.on('status', (s: HelperStatus) => {
    writeDiagnostic('input-helper-status', { status: s });
    // A helper that is starting or has stopped can no longer send the cancel that dismisses a wheel left on screen.
    if (s !== 'running') {
      overlays.cancelWheel();
      mate?.controller.cancel('helper');
      gesture.cancel(); // its key-up will never come
    }
    if (s === 'noAccess' && IS_MAC) {
      // Allowed but still refused is an entry left over from an earlier build. Otherwise wait for the user to allow it.
      if (trusted()) staleAccess = true;
      else waitForAccess();
      openSettingsWindow();
    }
    pushStatus();
    if (s === 'failed') overlays.toast(text().toastHelperStopped, text().toastHelperStoppedBody);
  });
  bridge.on('log', (line: string) => {
    console.log('[helper]', line);
    writeDiagnostic('input-helper-log', { message: line });
  });

  // The teammate: built when its feature is switched on, taken down when it is switched off or the app quits.
  let wordsSpots: Spot[] | null = null;
  let historyQuery = '';
  /** The agent profile whose Open in just failed; the History window says so until its next action. */
  let historyOpenFailed: string | null = null;
  /** Foreground apps of this session's asks, newest first; the rules card offers them as app names. */
  let recentApps: readonly string[] = [];
  function pushMateTray(): void {
    if (quitting) return;
    const h = settings.teammate.history;
    tray.setTeammate(mate
      ? { running: mate.controller.running, historyOn: h.on && mate.history.available(), paused: h.paused }
      : null);
  }
  function closeWords(): void {
    mate?.windows.hideWords(); // closes without an action, so the suspend is released here
    wordsSpots = null;
    if (!wordsOpen) return;
    wordsOpen = false;
    syncSuspended();
  }
  const historyState = async (m: Mate, query: string): Promise<HistoryState> => {
    const base = {
      view: 'history' as const, lang: mateLang(), query, threads: [],
      ...(historyOpenFailed !== null ? { openFailed: historyOpenFailed } : {}),
    };
    if (!m.history.available()) return { ...base, available: false, off: 'unavailable' };
    if (!settings.teammate.history.on) return { ...base, available: false, off: 'disabled' };
    // Open in <agent> shows only where the profile still exists and can continue a session.
    const threads = openInRows(await m.history.list(query), settings.teammate.profiles);
    return { ...base, available: true, threads };
  };
  const refreshHistory = async (m: Mate): Promise<void> => {
    const state = await historyState(m, historyQuery);
    if (mate === m) m.windows.updateHistory(state);
  };
  async function openHistory(): Promise<void> {
    const m = mate;
    if (!m) return;
    historyQuery = '';
    historyOpenFailed = null;
    const state = await historyState(m, historyQuery);
    if (mate === m) m.windows.showHistory(state);
  }
  function setHistoryPaused(paused: boolean): void {
    const t = settings.teammate;
    store.update({ teammate: { ...t, history: { ...t.history, paused } } });
  }
  /** Continues the thread's agent session in a terminal. The profile and command come from settings, not the window. */
  async function openInAgent(record: ThreadRecord | null): Promise<boolean> {
    const session = record?.agent;
    const profile = session ? resumableProfile(settings.teammate.profiles, session.profileId) : null;
    const args = profile && session ? resumeArgs(profile, session.session) : null;
    if (!session || !profile || !args) return true; // nothing the History window offered: not a failure to report
    const env = await userEnv();
    const file = findExecutable(profile.command, searchPath(env, PLATFORM), PLATFORM, isExecutable);
    const opened = file !== null && isDirectory(session.cwd)
      && await launchTerminal({ spawn, platform: PLATFORM, cwd: session.cwd, file, args, env });
    if (!opened) historyOpenFailed = profile.name;
    return opened;
  }
  const onHistoryAction = async (m: Mate, a: MateAction): Promise<void> => {
    // The failure line goes with the next action; delete, search and open in make the list again themselves.
    const hadFailure = historyOpenFailed !== null;
    historyOpenFailed = null;
    if (hadFailure && (a.t === 'open' || a.t === 'continue')) await refreshHistory(m);
    switch (a.t) {
      case 'open':
      case 'continue': {
        const record = await m.history.get(a.id);
        if (!record || mate !== m) return;
        // Open shows the thread at the cursor, over the History window; Continue makes it the one the next ask joins.
        if (a.t === 'open') m.controller.showThread(record, screen.getCursorScreenPoint());
        else m.controller.continueThread(record);
        return;
      }
      case 'openInAgent':
        // A failure is told in the list, which is made again either way.
        await openInAgent(await m.history.get(a.id));
        return refreshHistory(m);
      case 'delete':
        await m.history.delete(a.id);
        m.controller.forgetThread(a.id);
        return refreshHistory(m);
      case 'search':
        historyQuery = a.query;
        return refreshHistory(m);
      default:
        return;
    }
  };
  const onMateAction = ({ view, action }: { view: MateView; action: MateAction }): void => {
    const m = mate;
    if (!m) return;
    if (view === 'words') {
      const spots = wordsSpots;
      wordsSpots = null;
      wordsOpen = false;
      syncSuspended();
      const last = spots?.at(-1);
      if (action.t !== 'ask' || !spots || !last) return;
      // The words are the question, whatever slice the held spots were released on.
      const asked = [...spots.slice(0, -1), { ...last, intent: 'generic' as const }];
      m.controller.ask(asked, { text: action.text, newThread: action.newThread });
      return;
    }
    if (view === 'history') {
      onHistoryAction(m, action).catch((err: unknown) => console.warn('[teammate] history:', err));
      return;
    }
    if (view === 'consent' || view === 'form') {
      const t = action.t;
      const answer = t === 'allow' || t === 'always' || t === 'decline' || t === 'fill' || t === 'cancel';
      if (answer) m.actions.onAction(view, action);
      return;
    }
    if (action.t === 'copy') clipboard.writeText(action.text);
    else if (action.t === 'link') void shell.openExternal(action.url);
    else if (action.t === 'history') void openHistory();
    else m.controller.onTeammateAction(view, action);
  };
  /** Screen captures live here only during an ask; anything left from a crash or a late write goes at start and stop. */
  const mateTempDir = (): string => join(app.getPath('temp'), 'lolping-teammate');
  const createMate = (): Mate => {
    const dir = join(settingsDir(), 'teammate');
    const tempDir = mateTempDir();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const secrets = new SecretStore(join(dir, 'secrets'), safeStorage);
    const history = new HistoryStore(join(dir, 'history'), safeStorage, Date.now, {
      enabled: () => settings.teammate.history.on && !settings.teammate.history.paused,
      rule: () => ({ keepDays: settings.teammate.history.keepDays, maxThreads: settings.teammate.history.maxThreads }),
    });
    const usage = new UsageLog(join(dir, 'usage.json'), Date.now);
    const context = new ContextClient({ command: contextHelperPath() }); // context-helper starts on the first capture
    const windows = new MateWindows();
    // Chinese PDFs without their own character maps read as empty without pdfjs's CMaps.
    const pdf = pdfAssetDirs({
      packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(),
    });
    const actions = new ActionRunner({
      settings: () => settings,
      savePermissions: (permissions) => {
        store.update({ teammate: { ...settings.teammate, permissions } });
      },
      context,
      clipboard: {
        write: (item) => clipboard.write([new ClipboardItem({
          'text/plain': item.text, ...(item.html === undefined ? {} : { 'text/html': item.html }),
        })]),
      },
      openPath: (file) => shell.openPath(file),
      showInFolder: (file) => shell.showItemInFolder(file),
      openExternal: (url) => shell.openExternal(url),
      writeFile: (file, text) => writeFile(file, text, 'utf8'),
      tempDir: () => tempDir,
      windows: {
        showConsent: (at, s) => windows.showConsent(at, s),
        hideConsent: () => windows.hideConsent(),
        showForm: (at, s) => windows.showForm(at, s),
        hideForm: () => windows.hideForm(),
        cardHadFocus: () => windows.cardHadFocus(),
        // Through the controller, which keeps track of what it has on screen and brings back what a paste hid.
        hideCard: () => controller.hideCardForPut(),
        hideBubble: () => controller.hideBubbleForPut(),
        hideNow: (view) => windows.hideNow(view),
      },
      overlay: overlays,
      platform: PLATFORM,
      home: () => app.getPath('home'),
      zoneOffset: (d) => -d.getTimezoneOffset(),
      now: Date.now,
      timer: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    const agents = new AgentRunner({
      spawn, platform: PLATFORM, killTree: killProcessTree(PLATFORM),
      writeFile: (file, text) => writeFile(file, text, 'utf8'),
    });
    const userData = app.getPath('userData');
    /** The bridge's pipe once lolPing listens on it; agents run only then. */
    let pipe: string | null = null;
    const controller = new AskController({
      captureLease,
      agents: {
        runner: agents,
        bridge: {
          command: (ask) => {
            const at = pipe;
            // index.js and bridge.js are built side by side into out/main.
            return at === null ? null : bridgeCommand({
              execPath: process.execPath, bridgeJs: join(__dirname, 'bridge.js'), pipe: at, dataDir: userData, ask,
            });
          },
        },
        env: userEnv,
        home: () => app.getPath('home'),
        platform: PLATFORM,
      },
      settings: () => settings,
      lang: mateLang,
      secrets,
      context,
      ownPid: process.pid,
      readers: {
        readFile: (path) => readFile(path, 'utf8'),
        readDocument: (path, opts) => readDocument(path, { ...pdf, ...opts }),
        fetchWebPdf,
        readPdfBuffer: (name, data, opts) => readPdfBuffer(name, data, { ...pdf, ...opts }),
      },
      adapter: (p, key) => createAdapter(p, key),
      overlay: overlays,
      windows,
      history,
      tempDir: () => tempDir,
      thumbnail,
      now: Date.now,
      usage: (u) => usage.add(u),
      actions,
      cursor: cursorPhys,
      seenApp: (name) => {
        recentApps = rememberApp(recentApps, name, RECENT_APPS_MAX);
      },
      // Not while lolPing is paused, nor once the teammate is going down (its bridge stays up a moment longer).
      enabled: () => enabled && mate !== null,
    });
    // The pipe may be taken, possibly by another user's process: then nothing of an agent's goes through it.
    const mcp = (async (): Promise<BridgeServer> => {
      const { path, privateDir } = bridgeLocation(PLATFORM, userData, userInfo().username);
      const server = new BridgeServer({
        path, privateDir, tokenFile: join(userData, 'mcp-token'), handler: bridgeHandler(controller),
        random: randomBytes, writeToken: writeTokenFile,
      });
      await server.start();
      pipe = path;
      return server;
    })().catch((err: unknown) => {
      console.warn('[teammate] could not open the agent connection:', err);
      return null;
    });
    const stale = new StaleWatcher({
      front: (signal) => context.front(signal),
      busy: () => context.busy,
      ownPid: process.pid, // the teammate's windows and Settings belong to the main process
      helper: (on) => staleWatch('mate', on),
      own: (at) => {
        const dip = overlays.toDip(at);
        return dip !== null && (windows.contains(dip) || overShownWindow(dip, [settingsWindow(), textWindow()]));
      },
      stale: () => controller.stale(),
      every: (ms, fn) => {
        const timer = setInterval(fn, ms);
        return () => clearInterval(timer);
      },
    });
    controller.on('watch', (w: { window: string } | null) => (w ? stale.start(w.window) : stale.stop()));
    controller.on('state', pushMateTray);
    windows.on('action', onMateAction);
    windows.on('dragged', (view: MateView) => controller.onDragged(view));
    return { secrets, history, usage, context, windows, actions, controller, stale, agents, mcp };
  };
  /** Takes the teammate down; settles once its context helper has exited and its usage is on disk. */
  const stopMate = (): Promise<unknown> => {
    const m = mate;
    if (!m) return Promise.resolve();
    closeWords();
    gesture.cancel(); // while `mate` is still set, so a read made for held spots stops too
    mate = null;
    m.controller.cancel('user');
    m.agents.killAll(); // also on quitting: no agent, nor anything it started, outlives lolPing
    m.controller.removeAllListeners();
    m.stale.stop(); // the helper's watch goes off with the teammate
    m.actions.removeAllListeners();
    m.windows.removeAllListeners();
    m.windows.destroy();
    pushMateTray();
    // list() waits for the history queue, so no write of the old store is still running when a new one starts.
    // Once context-helper is gone nothing can still write a capture, so the folder is emptied after it.
    const captures = m.context.stop().finally(() => rm(mateTempDir(), { recursive: true, force: true }));
    // A new teammate listens on the same pipe, so it starts only once this one has let go of it.
    const bridged = m.mcp.then((server) => server?.stop());
    return Promise.allSettled([captures, m.usage.flush(), m.history.list(), bridged]);
  };
  /** A teammate going down: a new one starts only after it, so two stores never write the same files. */
  let mateStopping: Promise<unknown> | null = null;
  const syncMate = (): void => {
    const on = !IS_LINUX && featureOn(settings, 'teammate');
    if (on && !mate && !mateFailed) {
      if (mateStopping) {
        void mateStopping.then(syncMate);
        return;
      }
      try {
        mate = createMate();
        if (captureDepth > 0) mate.windows.setCaptureExcluded(true);
      } catch (err) {
        console.warn('[teammate] could not start:', err);
        mateFailed = true;
        sendConfig();
        overlays.updateSettings(overlaySettings(effective(settings), mateLang()));
      }
    } else if (!on && mate) {
      const stopping = stopMate();
      mateStopping = stopping;
      void stopping.then(() => {
        if (mateStopping === stopping) mateStopping = null;
      });
    }
    pushMateTray();
  };
  /** Opens the words box at the last spot; the ask goes with every spot when the words are sent. */
  function openWords(spots: Spot[]): void {
    const m = mate;
    const last = spots.at(-1);
    if (!m || !last) return;
    const current = m.controller.currentThread();
    try {
      // Showing a box cancels one still open from an earlier gesture, which clears the spots: set them after.
      m.windows.showWords(overlays.toDip(last.phys) ?? overlays.primaryDip(), {
        view: 'words', lang: mateLang(), tag: mateTag(), thread: current?.title ?? null,
        continueByDefault: wordsContinuesByDefault(current, Date.now()),
      });
    } catch (err) {
      console.warn('[teammate] words box:', err);
      return;
    }
    wordsSpots = spots;
    wordsOpen = true;
    syncSuspended();
  }
  overlays.on('askRelease', (r: AskRelease) => {
    gesture.release({ intent: r.id, phys: r.phys, displayId: r.displayId });
  });
  overlays.on('askClick', (c: AskClick) => {
    gesture.click({ intent: 'generic', phys: c.phys, displayId: c.displayId });
  });
  syncMate();

  store.on('change', (s: Settings) => {
    const previous = settings;
    settings = s;
    roomShots?.reconfigure();
    sendConfig();
    syncRoomText();
    syncRoomVotes();
    syncMate();
    const h = s.teammate.history;
    const was = previous.teammate.history;
    if (mate && (h.keepDays !== was.keepDays || h.maxThreads !== was.maxThreads)) {
      mate.history.prune({ keepDays: h.keepDays, maxThreads: h.maxThreads }).catch(() => undefined);
    }
    overlays.updateSettings(overlaySettings(effective(s), resolveLang(s.language, app.getLocale())));
    settingsWindow()?.webContents.send(SETTINGS_CH.changed, s);
    if (s.language !== previous.language) tray.setText(text());
    if (
      s.displayName !== previous.displayName || s.tagColor !== previous.tagColor
      || !sameTagRgb(s.tagColorCustom, previous.tagColorCustom)
      || featureOn(s, 'roomText') !== featureOn(previous, 'roomText')
      || featureOn(s, 'roomVotes') !== featureOn(previous, 'roomVotes')
      || s.roomShots.receive !== previous.roomShots.receive
    ) room.profileChanged();
    if (featureOn(s, 'rooms') !== featureOn(previous, 'rooms')) {
      if (!featureOn(s, 'rooms')) room.leave();
      tray.setRoomsShown(featureOn(s, 'rooms'));
    }
    if (s.autoUpdateCheck !== previous.autoUpdateCheck) updater?.setAutoCheck(s.autoUpdateCheck);
    if (s.roomMuted !== previous.roomMuted) {
      syncRoomFlags();
      pushRoom();
    }
    if (s.allowInternet !== previous.allowInternet) {
      room.setInternetAllowed(s.allowInternet);
      pushRoom();
    }
    if (app.isPackaged && s.launchAtStartup !== previous.launchAtStartup) {
      // macOS ignores args, and a Mac launch starts in the menu bar anyway.
      if (IS_LINUX) {
        try { setLinuxAutostart(s.launchAtStartup); }
        catch (err) {
          console.error('[autostart]', err);
          void dialog.showMessageBox({ type: 'error', message: String(err) });
        }
      }
      else app.setLoginItemSettings(IS_MAC ? { openAtLogin: s.launchAtStartup } : { openAtLogin: s.launchAtStartup, args: ['--hidden'] });
    }
  });

  registerSettingsIpc({
    store,
    library,
    getStatus: status,
    setEnabled,
    preview: (id) => overlays.previewPing(id),
    previewEmote: (ref) => overlays.previewEmote(ref),
    about,
    retryHelper: startHelper,
    setCapturing: (on) => {
      capturing = on;
      syncSuspended();
    },
    openAccessibility: () => {
      if (!IS_MAC) return;
      systemPreferences.isTrustedAccessibilityClient(true); // adds lolPing to the list and shows the system prompt
      void shell.openExternal(ACCESSIBILITY_PANE);
      if (!trusted()) waitForAccess();
    },
    text,
    platform: PLATFORM,
    update: updater
      ? { state: () => updater.state, notesUrl: () => updater.notesUrl, check: () => updater.check(true), start: () => updater.startUpdate() }
      : undefined,
    room: {
      state: roomState,
      create: () => room.create(),
      join: (t) => room.join(t),
      leave: () => room.leave(),
      mute: (peer, on) => room.muteMember(peer, on),
      clipboardCode,
      copyCode: copyRoomCode,
      retryInternet: () => relay.retryNow(),
    },
    teammate: {
      secrets: () => mate?.secrets ?? null,
      adapter: (p, key) => createAdapter(p, key),
      usage: () => mate?.usage.month() ?? { month: '', input: 0, output: 0 },
      screenAccess: () => (IS_MAC ? systemPreferences.getMediaAccessStatus('screen') === 'granted' : null),
      openScreenRecording: () => {
        if (IS_MAC) void shell.openExternal(SCREEN_RECORDING_PANE);
      },
      checkAgent: async (p) => {
        const env = await userEnv();
        return checkAgent(p, {
          find: (command) => findExecutable(command, searchPath(env, PLATFORM), PLATFORM, isExecutable),
          run: captureOutput({ spawn, platform: PLATFORM, killTree: killProcessTree(PLATFORM), env: () => env }),
        });
      },
      pickFolder: async () => {
        const w = settingsWindow();
        const options = { properties: ['openDirectory' as const] };
        const r = await (w ? dialog.showOpenDialog(w, options) : dialog.showOpenDialog(options));
        return r.canceled ? null : r.filePaths[0] ?? null;
      },
      agentSnippet: () => {
        const inputs = userBridgeInputs();
        return inputs === null ? null : userConfigSnippet(inputs);
      },
      bridge: () => {
        const inputs = userBridgeInputs();
        return inputs === null ? null : bridgeCommand({ ...inputs, ask: null });
      },
      recentApps: () => recentApps,
      editors: async () => {
        const env = await userEnv();
        return installedEditors({
          platform: PLATFORM,
          env: {
            ...searchPath(env, PLATFORM),
            LOCALAPPDATA: process.env.LOCALAPPDATA, ProgramFiles: process.env.ProgramFiles,
          },
          home: app.getPath('home'), exists: isExecutable, list: listDir,
        });
      },
      history: async (op: TeammateHistoryOp) => {
        if (op === 'open') {
          await openHistory();
          return mate !== null;
        }
        if (op === 'pause' || op === 'resume') {
          setHistoryPaused(op === 'pause');
          return true;
        }
        const m = mate;
        if (!m || !m.history.available()) return false;
        await m.history.clear();
        m.controller.forgetThread();
        await refreshHistory(m);
        return true;
      },
    },
  });
  // The page can't report that it went away mid-capture (window closed, renderer crashed): release the suspend here.
  onSettingsWindowGone(() => {
    if (!capturing) return;
    capturing = false;
    syncSuspended();
  });

  sendConfig();
  if (trusted()) bridge.start();
  else waitForAccess();
  pushStatus();
  syncRoomFlags();
  room.setInternetAllowed(settings.allowInternet);
  pushRoom();
  if (settings.rejoinRoom && settings.lastRoomCode && featureOn(settings, 'rooms')) void room.join(formatRoomCode(settings.lastRoomCode));
  if (IS_MAC) {
    // A menu bar app: open settings only when there is something to do, otherwise point at the menu bar icon.
    if (store.firstRun || !trusted()) openSettingsWindow();
    else overlays.toast(text().toastMenuBar, text().toastMenuBarBody);
  } else if (!process.argv.includes('--hidden')) {
    openSettingsWindow();
  }

  updater?.start();
  startupComplete();

  app.on('window-all-closed', () => {
    /* stay running: the overlays are the app */
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    updater?.stop(); // aborts a download and drops a check in flight; an install that is quitting the app is left alone
    room.quit(); // says bye, so the others see "left" instead of waiting for a timeout
    transfer.stop();
    stopWaitingForAccess();
    const mateStopped = stopMate();
    const roomShotsStopped = roomShots?.stop();
    tray.destroy();
    panels.destroy();
    overlays.destroy();
    void Promise.allSettled([bridge.stop(), store.flush(), lan.whenClosed(), relay.whenClosed(), mateStopped, roomShotsStopped])
      .then(() => app.exit(0));
  });
}
