import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerAppScheme, serveAppScheme } from '../../src/main/appProtocol';
import { RoomManager } from '../../src/main/roomManager';
import { RoomShotController } from '../../src/main/roomShotController';
import { ShotTransfer, shotHash } from '../../src/main/shotTransfer';
import { ShotWindows } from '../../src/main/shotWindows';
import { DEFAULT_ROOM_SHOTS, type ShotMeta } from '../../src/shared/roomShots';
import { formatRoomCode, makeRoomCode, parseRoomCode } from '../../src/shared/roomCode';
import type { RoomKeys } from '../../src/main/roomCrypto';
import { FakeTransport } from '../../tests/main/fixtures/fakeTransport';
import { strings } from '../../src/shared/i18n';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { SETTINGS_CH } from '../../src/shared/settingsChannels';
import { editSavedRooms, rememberSavedRoom } from '../../src/shared/savedRooms';
import type { RoomState } from '../../src/shared/room';

const output = process.argv[2], root = process.argv[3];
app.setPath('userData', join(output, 'native-profile'));
registerAppScheme();
app.disableHardwareAcceleration();
app.on('window-all-closed', () => undefined);
const checks: string[] = [], errors: string[] = [];
const check = (label: string, value: unknown): void => { assert(value, label); checks.push(label); };
const waitFor = async <T>(fn: () => T | Promise<T>, label: string): Promise<T> => {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const result = await fn(); if (result) return result;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout: ${label}`);
};
const js = <T>(w: BrowserWindow, source: string): Promise<T> => w.webContents.executeJavaScript(source);
const shotViews = (): BrowserWindow[] => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('/shots/'));
const imageReady = async (w: BrowserWindow): Promise<boolean> => js(w,
  "Boolean(document.querySelector('.frame img')?.complete && document.querySelector('.frame img')?.naturalWidth > 0)");
const readyFonts = async (w: BrowserWindow): Promise<void> => { await js(w, 'document.fonts.ready.then(() => true)'); };
const snapshot = async (w: BrowserWindow, file: string): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await readyFonts(w);
    await js(w, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const painted = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no native paint')), 5000);
      w.webContents.once('paint', () => { clearTimeout(timeout); resolve(); });
    });
    w.webContents.invalidate();
    await painted;
    try {
      const image = await w.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await writeFile(join(output, file), image.toPNG());
      return;
    } catch (error) {
      // Offscreen Viz can discard the resize frame; request a fresh paint instead of changing any UI assertion.
      if (attempt === 2 || !String(error).includes('UnknownVizError')) throw new Error(`${file}: ${String(error)}`);
    }
  }
};

async function run(): Promise<void> {
  await app.whenReady();
  serveAppScheme({ rendererRoot: join(root, 'out', 'renderer'), emoteDirs: () => [] });
  const settings = { ...DEFAULT_ROOM_SHOTS };
  const display = screen.getPrimaryDisplay();
  let now = 0;
  const windows = new ShotWindows({ hidden: true, now: () => now, settings: () => settings, lang: () => 'zh-CN',
    target: () => ({ displayId: display.id, width: display.bounds.width, height: display.bounds.height }) });
  const fixture = new BrowserWindow({ show: false, frame: false, useContentSize: true, width: 1920, height: 1080,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true } });
  await fixture.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><style>
    body{margin:0;background:#edf2f9;color:#19314e;font:22px/1.8 'Microsoft YaHei UI','Segoe UI',sans-serif;padding:100px 130px}
    h1{font-size:32px}pre{background:#182638;color:#e5edf7;padding:32px;border-radius:15px;font:22px/1.7 Consolas}
    aside{position:absolute;left:1120px;top:550px;color:#a52b31;font-size:28px}</style>
    <h1>离线测试图 · 标记与截图</h1><p>这是一张程序生成的测试页面，不包含桌面内容。</p>
    <pre>function sendMarker(point) {\n  const accepted = gate.admit();\n  if (accepted) shareCrop(point);\n}</pre>
    <aside>第二个标记：范围应扩大到这里</aside></html>`)}`);
  await readyFonts(fixture);
  await js(fixture, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const cropImage = await fixture.webContents.capturePage({ x: 180, y: 220, width: 640, height: 360 });
  const data = cropImage.toJPEG(85), size = cropImage.getSize();
  const meta: ShotMeta = { t: 'shot', id: '1'.repeat(16), rev: 1, d: 1, x: 0.5, y: 0.5,
    w: size.width, h: size.height, bytes: data.length, hash: shotHash(data), status: 'ready',
    marks: [{ x: 0.5, y: 0.5, n: 1 }] };
  const peer = 'b'.repeat(16);
  windows.update(peer, '离线测试成员', { meta, data: `data:image/jpeg;base64,${data.toString('base64')}`, status: 'ready' });
  const card = await waitFor(async () => {
    const w = shotViews()[0]; return w && await imageReady(w) ? w : null;
  }, 'card image');
  await readyFonts(card);
  check('card uses a hidden non-focusing native window', !card.isVisible() && !card.isFocusable());
  const corner = card.getBounds();
  check('corner card stays in the display work area', corner.x >= display.workArea.x && corner.y >= display.workArea.y
    && corner.x + corner.width <= display.workArea.x + display.workArea.width
    && corner.y + corner.height <= display.workArea.y + display.workArea.height);
  await snapshot(card, 'card-corner.png');
  settings.placement = 'spot'; windows.reconfigure();
  check('spot setting moves the same card without creating another window', shotViews().length === 1 && card.getBounds().x !== corner.x);
  const next = { ...meta, rev: 2, marks: [...meta.marks, { x: 0.8, y: 0.7, n: 2 }] };
  windows.update(peer, '离线测试成员', { meta: next, data: `data:image/jpeg;base64,${data.toString('base64')}`, status: 'ready' });
  await waitFor(() => js(card, 'document.querySelectorAll(".mark").length === 2'), 'merged marks');
  check('consecutive marks update one card', shotViews().length === 1);
  windows.update(peer, '离线测试成员', { meta, data: null, status: 'timeout' });
  check('old image updates do not replace the latest revision', await js(card, 'document.querySelectorAll(".mark").length === 2'));
  await js(card, 'document.querySelector(".viewport").click()');
  const viewer = await waitFor(async () => {
    for (const w of shotViews()) if (await js(w, 'document.body.className === "viewer"') && await imageReady(w)) return w;
    return null;
  }, 'viewer click');
  check('explicit click creates a focusable viewer, hidden in this test', viewer.isFocusable() && !viewer.isVisible());
  await js(viewer, 'Array.from(document.querySelectorAll("button")).find(b => b.textContent === "原始尺寸").click()');
  await waitFor(() => js(viewer, `Math.abs(document.querySelector('.frame').getBoundingClientRect().width - ${meta.w}) < 1`), '100 percent');
  check('viewer supports original size', true);
  await js(viewer, 'document.querySelector(".viewport").dispatchEvent(new WheelEvent("wheel", {deltaY:-100,cancelable:true}))');
  await waitFor(() => js(viewer, 'document.querySelector("footer").textContent.includes("120%")'), 'wheel zoom');
  check('viewer supports wheel zoom', true);
  await snapshot(viewer, 'viewer.png');
  await js(viewer, 'document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape"}))');
  await waitFor(() => viewer.isDestroyed(), 'Escape close'); check('Escape closes only the viewer', !card.isDestroyed());
  await js(card, 'document.documentElement.dispatchEvent(new MouseEvent("mouseenter"))');
  now = 20_000; windows.tick(); check('hover pauses card expiry', !card.isDestroyed());
  await js(card, 'document.documentElement.dispatchEvent(new MouseEvent("mouseleave"))');
  now += 10_001; windows.tick(); check('card expires after leaving and the display interval', card.isDestroyed());
  windows.update(peer, '离线测试成员', { meta: next, data: null, status: 'loading' });
  check('late updates do not reopen a dismissed group', shotViews().length === 0);
  windows.clear();
  const recoveryMeta = { ...meta, id: '4'.repeat(16) };
  windows.update(peer, '恢复测试', { meta: recoveryMeta, data: `data:image/jpeg;base64,${data.toString('base64')}`, status: 'ready' });
  const recoveryCard = await waitFor(async () => { const c = shotViews()[0]; return c && await imageReady(c) ? c : null; }, 'recovery card');
  recoveryCard.webContents.forcefullyCrashRenderer();
  await waitFor(() => recoveryCard.isDestroyed(), 'renderer crash cleanup');
  windows.update(peer, '恢复测试', { meta: { ...recoveryMeta, rev: 2 }, data: `data:image/jpeg;base64,${data.toString('base64')}`, status: 'ready' });
  const recovered = await waitFor(async () => { const c = shotViews()[0]; return c && await imageReady(c) ? c : null; }, 'renderer recovery');
  check('a crashed screenshot renderer recovers on the next update', !recovered.isDestroyed());
  windows.update(peer, '恢复测试', { meta: { ...recoveryMeta, rev: 3 }, data: null, status: 'loading' });
  await waitFor(() => js(recovered, 'document.querySelector("footer").textContent.includes("正在接收")'), 'pending status');
  check('the last readable screenshot remains available during a replacement', await imageReady(recovered));
  windows.update(peer, '恢复测试', { meta: { ...recoveryMeta, rev: 3 }, data: null, status: 'timeout' });
  await waitFor(() => js(recovered, 'document.querySelector("footer").textContent.includes("超时")'), 'timeout status');
  check('timeout keeps the last image and shows an explanation', await imageReady(recovered));
  windows.clear();

  // Actual room encryption, validation and chunk assembly, using in-memory transports only.
  const keys: RoomKeys = { msgKey: Buffer.alloc(32, 7), relayTopic: 'offline' };
  const transports = [new FakeTransport(), new FakeTransport()];
  const rooms = transports.map((t, i) => new RoomManager({ transports: [t], now: Date.now,
    randomBytes: (n) => new Uint8Array(n).fill(i + 1), deriveKeys: async () => keys, appVersion: '0.6.0',
    profile: () => ({ name: `离线成员 ${i + 1}`, color: i, rgb: null, limit: 5, nf: [], shots: true, markerLimits: settings }),
    announceEmotes: () => [], resolveTarget: () => ({ displayId: display.id, width: display.bounds.width, height: display.bounds.height }) }));
  const positions = [0, 0];
  const flush = (): void => {
    for (let n = 0; n < 8; n++) for (let i = 0; i < 2; i++) while (positions[i] < transports[i].sent.length)
      transports[1 - i].deliver(`lan:peer${i}:47474`, transports[i].sent[positions[i]++].packet);
  };
  const receiving = new ShotTransfer({ now: Date.now, self: () => rooms[1].self, peers: () => rooms[1].shotPeers(),
    send: (p, b) => rooms[1].sendShot(p, b), metadata: (p, m) => windows.update(p, '离线成员 1', { meta: m, data: null, status: 'loading' }),
    completed: (p, m, bytes) => windows.update(p, '离线成员 1', { meta: m, data: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`, status: 'ready' }),
    failed: (p, m) => windows.update(p, '离线成员 1', { meta: m, data: null, status: 'timeout' }) });
  const sending = new ShotTransfer({ now: Date.now, self: () => rooms[0].self, peers: () => rooms[0].shotPeers(),
    send: (p, b) => rooms[0].sendShot(p, b), metadata: () => undefined, completed: () => undefined, failed: () => undefined });
  rooms[1].on('shot', (m) => receiving.receive(m.peer, m)); rooms[0].on('shot', (m) => sending.receive(m.peer, m));
  const code = formatRoomCode(makeRoomCode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])));
  await Promise.all(rooms.map((r) => r.join(code)));
  const timer = setInterval(() => { sending.tick(); receiving.tick(); flush(); }, 25);
  await waitFor(() => rooms.every((r) => r.state().phase === 'active'), 'virtual room join');
  let mono = 0;
  const controller = new RoomShotController({ now: () => mono, id: () => '3'.repeat(16), settings: () => settings,
    source: () => ({ displayId: 1, number: 1, bounds: { x: 0, y: 0, w: 1920, h: 1080 },
      physical: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 }), canCapture: () => true,
    capture: async (crop) => {
      const img = await fixture.webContents.capturePage({ x: crop.rect.x, y: crop.rect.y, width: crop.rect.w, height: crop.rect.h });
      const size = img.getSize(); return { data: img.toJPEG(85), w: size.width, h: size.height };
    }, publish: (m, d) => sending.publish(m, d), watch: () => undefined, cooldown: () => undefined });
  const one = controller.admit({ displayId: 1, x: 500, y: 400 });
  rooms[0].sendPing('danger', { d: 1, x: 500 / 1920, y: 400 / 1080, batch: one.batch }); flush();
  mono = 100;
  const two = controller.admit({ displayId: 1, x: 1250, y: 650 });
  rooms[0].sendEmote('gg', { d: 1, x: 1250 / 1920, y: 650 / 1080, batch: two.batch }); flush();
  mono = 400; controller.tick();
  const flowCard = await waitFor(async () => { const c = shotViews()[0]; return c && await imageReady(c) ? c : null; }, 'encrypted merged screenshot');
  check('controller → encrypted room → chunk transfer → real card completes', await js(flowCard, 'document.querySelectorAll(".mark").length === 2'));
  await snapshot(flowCard, 'card-expanded.png');
  for (let i = 0; i < 3; i++) controller.admit({ displayId: 1, x: 800, y: 500 });
  check('sixth gesture is rejected in the UI flow', !controller.admit({ displayId: 1, x: 800, y: 500 }).allowed);
  mono += 10_000; check('cooldown recovers without replaying stored gestures', controller.admit({ displayId: 1, x: 800, y: 500 }).allowed);
  controller.invalidate(); clearInterval(timer); sending.clear(); receiving.clear(); rooms.forEach((r) => r.leave()); windows.clear();

  // The real overlay renderer, with its real preload: freeze the animation for repeatable visual QA.
  const overlay = new BrowserWindow({ width: 1920, height: 1080, show: false, frame: false, useContentSize: true, transparent: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: join(root, 'out', 'preload', 'overlay.js') } });
  overlay.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await overlay.loadURL('lolping://app/overlay/index.html');
  await js(overlay, 'document.body.style.background = "#243044"');
  overlay.webContents.send('marker:blocked', { text: strings('zh-CN').shots.blocked });
  await waitFor(() => js(overlay, 'document.querySelector(".marker-blocked").getAnimations().length === 1'), 'floating line');
  const hint = await js<{ size: string; color: string; x: number; y: number; text: string; viewportWidth: number }>(overlay, `(() => {
    const el = document.querySelector('.marker-blocked'), a = el.getAnimations()[0]; a.pause(); a.currentTime = 450;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return {size:s.fontSize,color:s.color,x:r.x+r.width/2,y:r.y,text:el.textContent,viewportWidth:innerWidth}; })()`);
  check('floating hint uses the requested text, gold colour and top-centre placement', hint.text === strings('zh-CN').shots.blocked
    && hint.size === '18px' && hint.color === 'rgb(228, 200, 137)' && Math.abs(hint.x - hint.viewportWidth / 2) < 1 && hint.y < 60);
  await readyFonts(overlay);
  await snapshot(overlay, 'blocked-hint.png');
  await writeFile(join(output, 'blocked-hint-detail.png'), (await overlay.webContents.capturePage(
    { x: Math.max(0, Math.round(hint.viewportWidth / 2 - 350)), y: 20, width: 700, height: 100 },
    { stayHidden: true, stayAwake: true })).toPNG());
  overlay.webContents.send('marker:blocked', { text: strings('zh-CN').shots.blocked });
  await waitFor(() => js(overlay, 'document.querySelector(".marker-blocked").getAnimations()[0].playState === "running"'), 'hint retrigger');
  check('each blocked attempt restarts one floating line instead of stacking', await js(overlay, 'document.querySelectorAll(".marker-blocked").length === 1'));
  const roomCodes = [3, 14, 10].map((n) => makeRoomCode(new Uint8Array(9).fill(n)));
  const savedFixture = roomCodes.map((code, n) => ({ code, label: ['午间开黑', '设计讨论', '周末好友组'][n], joinedAt: Date.now() - n * 1000 }));
  let current = mergeSettings(DEFAULT_SETTINGS, { language: 'zh-CN', savedRooms: savedFixture });
  let fixtureRoom: RoomState = { phase: 'idle', code: null, members: [], lan: 'off', internet: 'off', lonely: false, clockSkew: false, displays: [] };
  let joinMode: 'fail' | 'reject' | 'ok' = 'fail', joinCalls = 0;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    [SETTINGS_CH.get]: () => current,
    [SETTINGS_CH.status]: () => ({ enabled: true, helper: 'running', markerCooldownMs: 9000 }),
    [SETTINGS_CH.roomGet]: () => fixtureRoom,
    [SETTINGS_CH.about]: () => ({ version: '0.6.0', problems: [], limitations: [] }),
    [SETTINGS_CH.roomJoin]: (text) => {
      joinCalls++;
      if (joinMode === 'reject') throw new Error('synthetic IPC interruption');
      if (joinMode === 'fail') return { ok: false, error: 'failed' };
      const parsed = typeof text === 'string' ? parseRoomCode(text) : null;
      if (!parsed?.ok) return { ok: false, error: 'invalid' };
      fixtureRoom = { ...fixtureRoom, phase: 'active', code: formatRoomCode(parsed.code) };
      current = mergeSettings(current, { savedRooms: rememberSavedRoom(current.savedRooms, parsed.code, Date.now()) });
      return { ok: true };
    },
    [SETTINGS_CH.roomSavedEdit]: (edit) => {
      const savedRooms = editSavedRooms(current.savedRooms, edit);
      if (!savedRooms) return false;
      current = mergeSettings(current, { savedRooms });
      return true;
    },
  };
  for (const channel of Object.values(SETTINGS_CH)) if (!['settings:changed', 'status:changed', 'room:state', 'update:state', 'settings:showSection', SETTINGS_CH.set].includes(channel))
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const result = handlers[channel]?.(...args) ?? null;
      if (channel === SETTINGS_CH.roomJoin || channel === SETTINGS_CH.roomSavedEdit) {
        event.sender.send(SETTINGS_CH.changed, current);
        event.sender.send(SETTINGS_CH.roomChanged, fixtureRoom);
      }
      return result;
    });
  ipcMain.handle(SETTINGS_CH.set, (event, patch) => {
    current = mergeSettings(current, patch);
    event.sender.send(SETTINGS_CH.changed, current);
    return { ok: true, settings: current };
  });
  const settingsWindow = new BrowserWindow({ width: 1120, height: 940, show: false, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: join(root, 'out', 'preload', 'settings.js') } });
  settingsWindow.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await settingsWindow.loadURL('lolping://app/settings/index.html#room');
  await waitFor(() => js(settingsWindow, 'document.body.textContent.includes("发标记时附带截图")'), 'settings section');
  check('settings include screenshot switches, placement and the cooldown status', await js(settingsWindow,
    'document.body.textContent.includes("9 秒后可再次发送") && document.body.textContent.includes("截图显示位置")'));
  await js(settingsWindow, `Array.from(document.querySelectorAll('input[role="switch"]')).find(el => el.closest('.card')?.textContent.includes('发标记时附带截图')).click()`);
  await waitFor(() => !current.roomShots.enabled, 'settings switch save');
  check('screenshot settings save through the real preload and normalize correctly', !current.roomShots.enabled && current.roomShots.maxMarks === 5);
  await waitFor(() => js(settingsWindow, `!document.querySelector('.app.entering')`), 'settings entrance animation');
  await js(settingsWindow, `document.documentElement.style.scrollBehavior='auto'; document.getElementById('room').scrollIntoView({behavior:'instant',block:'start'})`);
  await snapshot(settingsWindow, 'settings-room.png');
  await waitFor(() => js(settingsWindow, 'document.querySelectorAll(".savedRoom").length === 3'), 'saved room rows');
  check('room list renders saved labels, codes and three join choices', await js(settingsWindow,
    'document.querySelector(".savedRooms").textContent.includes("午间开黑") && document.querySelectorAll(".savedRoom [data-action=join]").length === 3'));
  const pick = `[data-code="${roomCodes[2]}"]`;
  await js(settingsWindow, `document.querySelector('${pick} [data-action=join]').click(); document.querySelector('${pick} [data-action=join]').click()`);
  await waitFor(() => js(settingsWindow, 'document.querySelector(".savedRooms [role=alert]")?.textContent.includes("无法加入")'), 'join failure');
  check('failed double click sends one join and re-enables retry', joinCalls === 1 && await js(settingsWindow,
    `!document.querySelector('${pick} [data-action=join]').disabled`));
  joinMode = 'reject';
  await js(settingsWindow, `document.querySelector('${pick} [data-action=join]').click()`);
  await waitFor(() => js(settingsWindow, 'document.querySelector(".savedRooms [role=alert]")?.textContent.includes("更新列表失败")'), 'IPC interruption');
  check('IPC rejection is visible and does not freeze the list', await js(settingsWindow,
    `!document.querySelector('${pick} [data-action=join]').disabled`));
  joinMode = 'ok';
  await js(settingsWindow, `document.querySelector('${pick} [data-action=join]').click()`);
  await waitFor(() => js(settingsWindow, `document.querySelector('${pick}').textContent.includes('当前房间')`), 'room chosen');
  check('an all-letter room code joins through the real preload and becomes current', fixtureRoom.code === formatRoomCode(roomCodes[2])
    && await js(settingsWindow, `document.querySelector('${pick} [data-action=join]').disabled`));
  await js(settingsWindow, `document.querySelector('${pick} [data-action=rename]').click()`);
  await waitFor(() => js(settingsWindow, 'Boolean(document.querySelector(".savedRoomEditor input"))'), 'rename editor');
  await js(settingsWindow, `const input=document.querySelector('.savedRoomEditor input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'研发 午间组');
    input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await js(settingsWindow, 'document.querySelector(".savedRoomEditor [data-action=save]").click()');
  await waitFor(() => current.savedRooms.some((row) => row.code === roomCodes[2] && row.label === '研发 午间组'), 'rename saved');
  check('renaming keeps spaces and the original room code', current.savedRooms[0].code === roomCodes[2]);
  await js(settingsWindow, `document.querySelector('[data-code="${roomCodes[0]}"] [data-action=join]').click()`);
  await waitFor(() => js(settingsWindow, `document.querySelector('[data-code="${roomCodes[0]}"]').textContent.includes('当前房间')`), 'switch selected room');
  check('switching from a saved room selects the destination and moves it to the top',
    fixtureRoom.code === formatRoomCode(roomCodes[0]) && current.savedRooms[0].code === roomCodes[0]);
  await js(settingsWindow, `document.querySelector('${pick} [data-action=join]').click()`);
  await waitFor(() => js(settingsWindow, `document.querySelector('${pick}').textContent.includes('当前房间')`), 'switch back');
  await js(settingsWindow, `document.querySelector('${pick} [data-action=forget]').click()`);
  await waitFor(() => js(settingsWindow, 'document.querySelectorAll(".savedRoom").length === 2'), 'room forgotten');
  check('removing the current room record does not leave the room', fixtureRoom.code === formatRoomCode(roomCodes[2]) && fixtureRoom.phase === 'active');
  current = mergeSettings(current, { savedRooms: [] });
  settingsWindow.webContents.send(SETTINGS_CH.changed, current);
  await waitFor(() => js(settingsWindow, 'Boolean(document.querySelector(".savedRoomsEmpty"))'), 'empty list');
  await settingsWindow.loadURL('lolping://app/settings/index.html#room');
  await waitFor(() => js(settingsWindow, 'Boolean(document.querySelector(".savedRoomsEmpty"))'), 'empty list reload');
  check('an intentionally empty list survives renderer reload without resurrecting a room', current.savedRooms.length === 0);
  current = mergeSettings(current, { savedRooms: Array.from({ length: 20 }, (_, n) => ({
    code: makeRoomCode(new Uint8Array(9).fill(n)), label: `Fixture ${n}`, joinedAt: Date.now() - n })) });
  settingsWindow.webContents.send(SETTINGS_CH.changed, current);
  await waitFor(() => js(settingsWindow, 'document.querySelectorAll(".savedRoom").length === 20'), 'bounded room list');
  check('twenty rooms use an independently scrolling list', await js(settingsWindow,
    '(()=>{const list=document.querySelector(".savedRoomsList");return list.scrollHeight>list.clientHeight && list.clientHeight<=380;})()'));
  current = mergeSettings(current, { savedRooms: savedFixture });
  fixtureRoom = { ...fixtureRoom, code: formatRoomCode(roomCodes[0]), phase: 'joining' };
  settingsWindow.webContents.send(SETTINGS_CH.changed, current);
  settingsWindow.webContents.send(SETTINGS_CH.roomChanged, fixtureRoom);
  await waitFor(() => js(settingsWindow, 'document.querySelectorAll(".savedRoom").length === 3'), 'joining list');
  check('joining disables all list join actions', await js(settingsWindow,
    'Array.from(document.querySelectorAll(".savedRoom [data-action=join]")).every(b=>b.disabled)'));
  fixtureRoom = { ...fixtureRoom, phase: 'active' };
  settingsWindow.webContents.send(SETTINGS_CH.roomChanged, fixtureRoom);
  current = mergeSettings(current, { language: 'en' });
  settingsWindow.webContents.send(SETTINGS_CH.changed, current);
  await waitFor(() => js(settingsWindow, 'document.querySelector(".savedRooms")?.textContent.includes("Your rooms")'), 'English room list');
  check('English room list strings render', true);
  current = mergeSettings(current, { language: 'zh-CN' });
  settingsWindow.webContents.send(SETTINGS_CH.changed, current);
  await waitFor(() => js(settingsWindow, 'document.querySelector(".savedRooms")?.textContent.includes("房间列表")'), 'Chinese room list');
  await js(settingsWindow, 'document.querySelector(".savedRooms").scrollIntoView({behavior:"instant",block:"center"})');
  await snapshot(settingsWindow, 'room-list.png');
  const listRect = await js<{ x: number; y: number; width: number; height: number }>(settingsWindow,
    '(()=>{const r=document.querySelector(".savedRooms").getBoundingClientRect();return {x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.floor(r.height)};})()');
  await writeFile(join(output, 'room-list-card.png'), (await settingsWindow.webContents.capturePage(listRect,
    { stayHidden: true, stayAwake: true })).toPNG());
  settingsWindow.setContentSize(720, 940);
  await waitFor(() => js(settingsWindow, 'window.innerWidth === 720'), 'compact room list');
  await js(settingsWindow, 'document.querySelector(".savedRooms").scrollIntoView({behavior:"instant",block:"center"})');
  check('room actions fit inside the card at the minimum window width', await js(settingsWindow,
    `(()=>{const card=document.querySelector('.savedRooms').getBoundingClientRect();
    return Array.from(document.querySelectorAll('.savedRoomActions button')).every(b=>{
      const r=b.getBoundingClientRect();return r.left>=card.left && r.right<=card.right+1;});})()`));
  await snapshot(settingsWindow, 'room-list-compact.png');
  check('all test windows remain hidden throughout', BrowserWindow.getAllWindows().every((w) => !w.isVisible()));
  windows.destroy();
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  await writeFile(join(output, 'native-ui-summary.json'), JSON.stringify({ passed: checks.length, checks, errors, hint,
    boundary: 'Hidden native Windows windows, program-generated image fixture and encrypted in-memory peers. No desktop capture, physical input or public relay.' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, output }));
}

run().then(() => app.exit(0), async (err: unknown) => {
  console.error(err);
  await writeFile(join(output, 'native-ui-summary.json'), JSON.stringify({ passed: checks.length, checks, failed: String(err), errors }, null, 2));
  app.exit(1);
});
