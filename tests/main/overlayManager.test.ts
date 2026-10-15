import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmoteArt } from '../../src/shared/emotes';
import { OVERLAY_EMOTED, OVERLAY_PINGED } from '../../src/shared/ipc';
import { DEFAULT_SETTINGS, overlaySettings } from '../../src/shared/settings';

const h = vi.hoisted(() => ({
  windows: [] as Array<{ x: number; webContents: { send: ReturnType<typeof vi.fn> } }>,
  handlers: new Map<string, (event: unknown, raw: unknown) => void>(),
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeWindow extends Emitter {
    static fromWebContents(wc: unknown): FakeWindow | null {
      return (h.windows as unknown as FakeWindow[]).find((w) => w.webContents === wc) ?? null;
    }
    x: number;
    webContents = Object.assign(new Emitter(), { send: vi.fn() });
    constructor(opts: { x: number }) {
      super();
      this.x = opts.x;
      h.windows.push(this);
    }
    setIgnoreMouseEvents(): void {}
    setAlwaysOnTop(): void {}
    setBounds(): void {}
    showInactive(): void {}
    isDestroyed(): boolean {
      return false;
    }
    destroy(): void {}
  }
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, scaleFactor: 1 },
  ];
  const screen = Object.assign(new Emitter(), {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    dipToScreenRect: (_win: unknown, r: unknown) => r,
  });
  const ipcMain = { on: (channel: string, fn: (event: unknown, raw: unknown) => void) => h.handlers.set(channel, fn) };
  return { BrowserWindow: FakeWindow, ipcMain, screen };
});

vi.mock('../../src/main/paths', () => ({
  IS_MAC: false,
  loadPage: () => Promise.resolve(),
  preloadPath: () => 'preload.js',
}));

type Manager = InstanceType<typeof import('../../src/main/overlayManager').OverlayManager>;
let mgr: Manager;
let resolveArt: ReturnType<typeof vi.fn<(ref: string, remote: boolean) => EmoteArt>>;

const art = (ref: string, remote: boolean): EmoteArt => ({ kind: 'bundled', slug: `${ref}${remote ? '-remote' : ''}` });
/** What display 1 (index 0) or display 2 (index 1) was told, minus the settings it gets on load. */
const sent = (i: number): Array<[string, unknown]> =>
  h.windows[i].webContents.send.mock.calls.filter((c) => c[0] !== 'overlay:settings') as Array<[string, unknown]>;

beforeEach(async () => {
  h.windows.length = 0;
  h.handlers.clear();
  vi.resetModules();
  const { OverlayManager } = await import('../../src/main/overlayManager');
  resolveArt = vi.fn(art);
  mgr = new OverlayManager(overlaySettings({ ...DEFAULT_SETTINGS, clickEmoteId: 'okay' }), resolveArt);
  mgr.start();
});

describe('OverlayManager wheels', () => {
  it('forwards the open wheel\'s kind with every move and the release', () => {
    mgr.handle({ type: 'wheelOpen', x: 100, y: 200, wheel: 'emote' });
    mgr.handle({ type: 'wheelMove', x: 110, y: 210, wheel: 'emote' });
    mgr.handle({ type: 'wheelRelease', x: 120, y: 220, wheel: 'emote' });
    expect(sent(0)).toEqual([
      ['wheel:open', { x: 100, y: 200, wheel: 'emote' }],
      ['wheel:move', { x: 110, y: 210, wheel: 'emote' }],
      ['wheel:release', { x: 120, y: 220, wheel: 'emote' }],
    ]);
  });

  it('keeps the ping wheel a ping wheel after an emote one', () => {
    mgr.handle({ type: 'wheelOpen', x: 1, y: 1, wheel: 'emote' });
    mgr.handle({ type: 'wheelRelease', x: 1, y: 1, wheel: 'emote' });
    mgr.handle({ type: 'wheelOpen', x: 5, y: 5, wheel: 'ping' });
    mgr.handle({ type: 'wheelMove', x: 6, y: 6, wheel: 'ping' });
    expect(sent(0).slice(2)).toEqual([
      ['wheel:open', { x: 5, y: 5, wheel: 'ping' }],
      ['wheel:move', { x: 6, y: 6, wheel: 'ping' }],
    ]);
  });
});

describe('OverlayManager emote clicks', () => {
  it('shows the click emote where it was clicked, clears ours on the other displays and shares it', () => {
    const shared = vi.fn();
    mgr.on('sharedEmote', shared);
    mgr.on('shared', shared);
    mgr.handle({ type: 'click', x: 1920 + 300, y: 400, wheel: 'emote' });
    expect(sent(1)).toEqual([['emote:spawn', { owner: 'self', art: art('okay', false), x: 300, y: 400 }]]);
    expect(sent(0)).toEqual([['emote:clear', { owner: 'self' }]]);
    expect(resolveArt).toHaveBeenCalledWith('okay', false);
    expect(shared).toHaveBeenCalledOnce();
    expect(shared).toHaveBeenCalledWith({ ref: 'okay', displayId: 2, x: 300, y: 400 });
  });

  it('still drops the click ping for a ping click', () => {
    const emoted = vi.fn();
    const pinged = vi.fn();
    mgr.on('sharedEmote', emoted);
    mgr.on('shared', pinged);
    mgr.handle({ type: 'click', x: 50, y: 60, wheel: 'ping' });
    expect(sent(0)).toEqual([['ping:spawn', { id: DEFAULT_SETTINGS.clickPingId, x: 50, y: 60 }]]);
    expect(sent(1)).toEqual([]);
    expect(emoted).not.toHaveBeenCalled();
    expect(pinged).toHaveBeenCalledOnce();
  });
});

describe('OverlayManager emote reports from the overlay', () => {
  const sender = (i: number): unknown => h.windows[i].webContents;

  it('shares a wheel emote from the display that placed it and clears ours elsewhere', () => {
    const shared = vi.fn();
    mgr.on('sharedEmote', shared);
    h.handlers.get(OVERLAY_EMOTED)!({ sender: sender(1) }, { ref: 'c:' + 'a'.repeat(32), x: 10, y: 20 });
    expect(shared).toHaveBeenCalledWith({ ref: 'c:' + 'a'.repeat(32), displayId: 2, x: 10, y: 20 });
    expect(sent(0)).toEqual([['emote:clear', { owner: 'self' }]]);
    expect(sent(1)).toEqual([]);
  });

  it('ignores a malformed report', () => {
    const shared = vi.fn();
    mgr.on('sharedEmote', shared);
    const report = h.handlers.get(OVERLAY_EMOTED)!;
    for (const raw of [
      null, 'x', 5, {}, { ref: 'Bad Ref', x: 1, y: 1 }, { ref: 'c:abc', x: 1, y: 1 }, { ref: 'okay', x: Number.NaN, y: 1 },
      { ref: 'okay', x: 1, y: Infinity }, { ref: 'okay', x: '1', y: 1 }, { ref: 7, x: 1, y: 1 },
    ]) report({ sender: sender(0) }, raw);
    report({ sender: {} }, { ref: 'okay', x: 1, y: 1 }); // not one of our windows
    expect(shared).not.toHaveBeenCalled();
    expect(sent(0)).toEqual([]);
    expect(sent(1)).toEqual([]);
  });

  it('still shares pings', () => {
    const shared = vi.fn();
    mgr.on('shared', shared);
    h.handlers.get(OVERLAY_PINGED)!({ sender: sender(0) }, { id: 'danger', x: 1, y: 2 });
    expect(shared).toHaveBeenCalledWith({ id: 'danger', displayId: 1, x: 1, y: 2 });
  });
});

describe('OverlayManager remote and preview emotes', () => {
  it('shows a room member\'s emote on the target display with their tag, and clears theirs on the others', () => {
    mgr.spawnRemoteEmote({ displayId: 2, x: 5, y: 6, ref: 'gg_heart', peer: 'peer-1', tag: { name: 'Bob', color: 2 } });
    expect(resolveArt).toHaveBeenCalledWith('gg_heart', true);
    expect(sent(1)).toEqual([['emote:spawn', { owner: 'peer-1', art: art('gg_heart', true), x: 5, y: 6, tag: { name: 'Bob', color: 2 } }]]);
    expect(sent(0)).toEqual([['emote:clear', { owner: 'peer-1' }]]);
  });

  it('previews in the middle of the main display without sharing', () => {
    const shared = vi.fn();
    mgr.on('sharedEmote', shared);
    mgr.previewEmote('nice');
    expect(resolveArt).toHaveBeenCalledWith('nice', false);
    expect(sent(0)).toEqual([['emote:spawn', { owner: 'preview', art: art('nice', false), x: 960, y: 540 }]]);
    expect(sent(1)).toEqual([]);
    expect(shared).not.toHaveBeenCalled();
  });
});
