import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parkedBounds } from '../../src/main/overlayManager';
import type { EmoteArt } from '../../src/shared/emotes';
import { OVERLAY_EMOTED, OVERLAY_IDLE, OVERLAY_PINGED } from '../../src/shared/ipc';
import { DEFAULT_SETTINGS, overlaySettings } from '../../src/shared/settings';

type Rect = { x: number; y: number; width: number; height: number };

const h = vi.hoisted(() => {
  const initial = () => [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, scaleFactor: 1 },
  ];
  const displays = initial();
  return {
    windows: [] as Array<{
      x: number;
      bounds: Rect;
      emit: (event: string) => boolean;
      webContents: { send: ReturnType<typeof vi.fn> };
      onTop: string[];
      hiddenInMissionControl: boolean;
      contentProtection: boolean[];
      visible: boolean;
    }>,
    handlers: new Map<string, (event: unknown, raw: unknown) => void>(),
    isMac: false,
    isLinux: false,
    displays,
    /** Swaps a fake display's bounds for a new object, the way Electron hands out fresh ones on every query. */
    setDisplayBounds(id: number, b: { width?: number; height?: number }): void {
      const d = displays.find((d) => d.id === id);
      if (d) d.bounds = { ...d.bounds, ...b };
    },
    /** Puts the fake displays back the way each test starts. */
    resetDisplays(): void {
      displays.splice(0, displays.length, ...initial());
    },
  };
});

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeWindow extends Emitter {
    static fromWebContents(wc: unknown): FakeWindow | null {
      return (h.windows as unknown as FakeWindow[]).find((w) => w.webContents === wc) ?? null;
    }
    x: number;
    bounds: Rect;
    webContents = Object.assign(new Emitter(), { send: vi.fn() });
    constructor(opts: Rect) {
      super();
      this.x = opts.x;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      h.windows.push(this);
    }
    /** Every always-on-top level set on it, in order. */
    onTop: string[] = [];
    setIgnoreMouseEvents(): void {}
    setAlwaysOnTop(_flag: boolean, level: string): void {
      this.onTop.push(level);
    }
    setVisibleOnAllWorkspaces(): void {}
    hiddenInMissionControl = false;
    setHiddenInMissionControl(hidden: boolean): void {
      this.hiddenInMissionControl = hidden;
    }
    /** Every setContentProtection call, in order. */
    contentProtection: boolean[] = [];
    setContentProtection(on: boolean): void {
      this.contentProtection.push(on);
    }
    setBounds(r: Rect): void {
      this.bounds = r;
    }
    visible = false;
    showInactive(): void {
      this.visible = true;
    }
    hide(): void {
      this.visible = false;
    }
    isVisible(): boolean {
      return this.visible;
    }
    isDestroyed(): boolean {
      return false;
    }
    destroy(): void {}
  }
  const screen = Object.assign(new Emitter(), {
    getAllDisplays: () => h.displays,
    getPrimaryDisplay: () => h.displays[0],
    dipToScreenRect: (_win: unknown, r: unknown) => r,
  });
  screen.setMaxListeners(0); // every test starts a manager on this one fake screen
  const ipcMain = { on: (channel: string, fn: (event: unknown, raw: unknown) => void) => h.handlers.set(channel, fn) };
  return { BrowserWindow: FakeWindow, ipcMain, screen };
});

vi.mock('../../src/main/paths', () => ({
  get IS_MAC() {
    return h.isMac;
  },
  get IS_LINUX() {
    return h.isLinux;
  },
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
  h.isMac = false;
  h.isLinux = false;
  h.resetDisplays();
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

describe('OverlayManager ask wheel', () => {
  const askOn = (intents: object = {}) => mgr.updateSettings(overlaySettings({
    ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features, teammate: true },
    teammate: { ...DEFAULT_SETTINGS.teammate, intents },
  }));

  it('reports an ask release without sharing it with the room', () => {
    askOn();
    const shared = vi.fn();
    const asked = vi.fn();
    mgr.on('shared', shared);
    mgr.on('sharedEmote', shared);
    mgr.on('askRelease', asked);
    mgr.handle({ type: 'wheelOpen', x: 1920 + 500, y: 500, wheel: 'ask' });
    mgr.handle({ type: 'wheelMove', x: 1920 + 500, y: 380, wheel: 'ask' });
    mgr.handle({ type: 'wheelRelease', x: 1920 + 500, y: 360, wheel: 'ask' });
    expect(sent(1)).toEqual([
      ['wheel:open', { x: 500, y: 500, wheel: 'ask' }],
      ['wheel:move', { x: 500, y: 380, wheel: 'ask' }],
      ['wheel:release', { x: 500, y: 360, wheel: 'ask' }],
    ]);
    expect(asked).toHaveBeenCalledExactlyOnceWith({ displayId: 2, x: 500, y: 500, phys: { x: 1920 + 500, y: 500 }, id: 'danger' });
    expect(shared).not.toHaveBeenCalled();
  });

  it('ignores a release on a switched-off intent', () => {
    askOn({ danger: { enabled: false } });
    const asked = vi.fn();
    mgr.on('askRelease', asked);
    mgr.handle({ type: 'wheelOpen', x: 500, y: 500, wheel: 'ask' });
    mgr.handle({ type: 'wheelRelease', x: 500, y: 360, wheel: 'ask' });
    mgr.handle({ type: 'wheelOpen', x: 500, y: 500, wheel: 'ask' });
    mgr.handle({ type: 'wheelRelease', x: 500, y: 490, wheel: 'ask' }); // the dead zone
    expect(asked).not.toHaveBeenCalled();
    mgr.handle({ type: 'wheelOpen', x: 500, y: 500, wheel: 'ask' });
    mgr.handle({ type: 'wheelRelease', x: 640, y: 500, wheel: 'ask' }); // east: the third slice
    expect(asked).toHaveBeenCalledExactlyOnceWith({ displayId: 1, x: 500, y: 500, phys: { x: 500, y: 500 }, id: 'omw' });
  });

  describe('on the ping key', () => {
    const sameKey = (o: { intents?: object; askClick?: boolean } = {}) => mgr.updateSettings(overlaySettings({
      ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features, teammate: true },
      teammate: { ...DEFAULT_SETTINGS.teammate, askTrigger: 'same', intents: o.intents ?? {}, askClick: o.askClick ?? true },
    }));

    it('asks with a ping-wheel release and shares nothing with the room', () => {
      sameKey();
      const shared = vi.fn();
      const asked = vi.fn();
      mgr.on('shared', shared);
      mgr.on('askRelease', asked);
      mgr.handle({ type: 'wheelOpen', x: 500, y: 500, wheel: 'ping' });
      mgr.handle({ type: 'wheelRelease', x: 500, y: 360, wheel: 'ping' });
      expect(sent(0)).toEqual([
        ['wheel:open', { x: 500, y: 500, wheel: 'ask' }],
        ['wheel:release', { x: 500, y: 360, wheel: 'ask' }],
      ]);
      expect(asked).toHaveBeenCalledExactlyOnceWith({ displayId: 1, x: 500, y: 500, phys: { x: 500, y: 500 }, id: 'danger' });
      expect(shared).not.toHaveBeenCalled();
    });

    it('keeps a switched-off intent a normal ping for the room', () => {
      sameKey({ intents: { danger: { enabled: false } } });
      const shared = vi.fn();
      const asked = vi.fn();
      mgr.on('shared', shared);
      mgr.on('askRelease', asked);
      mgr.handle({ type: 'wheelOpen', x: 500, y: 500, wheel: 'ping' });
      mgr.handle({ type: 'wheelRelease', x: 500, y: 360, wheel: 'ping' });
      expect(asked).not.toHaveBeenCalled();
      expect(sent(0).at(-1)).toEqual(['ping:spawn', { id: 'danger', x: 500, y: 500 }]);
      expect(shared).toHaveBeenCalledExactlyOnceWith({ id: 'danger', displayId: 1, x: 500, y: 500 });
    });

    it('opens the words box for a ping click while ask with words is on, and pings otherwise', () => {
      sameKey();
      const shared = vi.fn();
      const clicked = vi.fn();
      mgr.on('shared', shared);
      mgr.on('askClick', clicked);
      mgr.handle({ type: 'click', x: 30, y: 40, wheel: 'ping' });
      expect(clicked).toHaveBeenCalledExactlyOnceWith({ displayId: 1, x: 30, y: 40, phys: { x: 30, y: 40 } });
      expect(shared).not.toHaveBeenCalled();
      sameKey({ askClick: false });
      mgr.handle({ type: 'click', x: 30, y: 40, wheel: 'ping' });
      expect(clicked).toHaveBeenCalledOnce();
      expect(shared).toHaveBeenCalledOnce();
    });
  });

  it('opens the words box at the pointer on a double tap', () => {
    askOn();
    const clicked = vi.fn();
    mgr.on('askClick', clicked);
    mgr.handle({ type: 'askWords', x: 1920 + 30, y: 40 });
    expect(clicked).toHaveBeenCalledExactlyOnceWith({ displayId: 2, x: 30, y: 40, phys: { x: 1920 + 30, y: 40 } });
    expect(sent(0)).toEqual([]);
    expect(sent(1)).toEqual([]);
  });

  it('reports an ask click without sharing it or drawing a ping', () => {
    askOn();
    const shared = vi.fn();
    const clicked = vi.fn();
    mgr.on('shared', shared);
    mgr.on('sharedEmote', shared);
    mgr.on('askClick', clicked);
    mgr.handle({ type: 'click', x: 1920 + 30, y: 40, wheel: 'ask' });
    expect(clicked).toHaveBeenCalledExactlyOnceWith({ displayId: 2, x: 30, y: 40, phys: { x: 1920 + 30, y: 40 } });
    expect(shared).not.toHaveBeenCalled();
    expect(sent(0)).toEqual([]);
    expect(sent(1)).toEqual([]);
  });

  it('draws the teammate\'s pings and emotes with its tag, and clears or fades them everywhere', () => {
    const tag = { name: 'AI', color: 3 };
    mgr.spawnMate({ displayId: 2, x: 10, y: 20, id: 'danger', label: 'typo', silent: true, tag });
    mgr.spawnMateEmote({ displayId: 1, x: 5, y: 6, slug: 'okay', tag });
    mgr.clearMate();
    mgr.fadeMate();
    expect(sent(1)).toEqual([
      ['ping:spawn', { id: 'danger', x: 10, y: 20, owner: 'mate', label: 'typo', silent: true, tag }],
      ['emote:clear', { owner: 'mate' }],
      ['mate:clear', null],
      ['mate:fade', null],
    ]);
    expect(sent(0)).toEqual([
      ['emote:spawn', { owner: 'mate', art: { kind: 'bundled', slug: 'okay' }, x: 5, y: 6, tag }],
      ['mate:clear', null],
      ['mate:fade', null],
    ]);
  });

  it('sends a kept teammate emote with keep, for the overlay to hold until it fades', () => {
    const tag = { name: 'AI', color: 3 };
    mgr.spawnMateEmote({ displayId: 1, x: 5, y: 6, slug: 'okay', keep: true, tag });
    expect(sent(0)).toEqual([
      ['emote:spawn', { owner: 'mate', art: { kind: 'bundled', slug: 'okay' }, x: 5, y: 6, tag, keep: true }],
    ]);
  });

  it('stamps the teammate\'s pings with the current ask\'s ticket', () => {
    const tag = { name: 'AI', color: 3 };
    mgr.setMateTicket('t1');
    mgr.spawnMate({ displayId: 1, x: 1, y: 2, id: 'push', tag });
    expect(sent(0)).toEqual([
      ['mate:ticket', { id: 't1' }],
      ['ping:spawn', { id: 'push', x: 1, y: 2, owner: 'mate', tag, ticket: 't1' }],
    ]);
    expect(sent(1)).toEqual([['mate:ticket', { id: 't1' }]]);
  });

  it('keeps the receipt and draws a tag-only one, and stops every tag’s dots once the teammate speaks', () => {
    const tag = { name: 'AI', color: 3 };
    mgr.spawnMate({ displayId: 1, x: 1, y: 2, id: 'omw', thinking: true, keep: true, tagOnly: true, tag });
    mgr.mateSaid();
    expect(sent(0)).toEqual([
      ['ping:spawn', { id: 'omw', x: 1, y: 2, thinking: true, keep: true, tagOnly: true, owner: 'mate', tag }],
      ['mate:said', null],
    ]);
    expect(sent(1)).toEqual([['mate:said', null]]);
  });

  it('outlines each field the teammate wrote on its own display, in order and 120 ms apart', () => {
    // No gesture picks up the new scale first: the glow checks the displays itself.
    h.displays[1].scaleFactor = 2;
    mgr.setMateTicket('t1');
    mgr.glow([
      { x: 1920 + 100, y: 200, w: 300, h: 30 },
      { x: 100, y: 200, w: 300, h: 30 },
      { x: 100, y: 260, w: 300, h: 30 },
    ], { name: 'AI', color: 3, rgb: [10, 20, 30] });
    const glows = (i: number): unknown[] => sent(i).filter((m) => m[0] === 'mate:glow').map((m) => m[1]);
    // Display 2 is at 200 %: its overlay's CSS px are half the physical px.
    expect(glows(1)).toEqual([
      { box: { x: 50, y: 100, w: 150, h: 15 }, color: 3, rgb: [10, 20, 30], delay: 0, ticket: 't1' },
    ]);
    expect(glows(0)).toEqual([
      { box: { x: 100, y: 200, w: 300, h: 30 }, color: 3, rgb: [10, 20, 30], delay: 120, ticket: 't1' },
      { box: { x: 100, y: 260, w: 300, h: 30 }, color: 3, rgb: [10, 20, 30], delay: 240, ticket: 't1' },
    ]);
  });

  it('maps a physical point to a screen point in DIPs for the teammate’s windows', () => {
    h.displays[1].scaleFactor = 2;
    mgr.handle({ type: 'wheelOpen', x: 10, y: 10, wheel: 'ping' }); // the next gesture picks up the new scale
    expect(mgr.toDip({ x: 1920 + 100, y: 60 })).toEqual({ x: 1920 + 50, y: 30 });
  });

  it('falls back to the middle of the main display for the teammate\'s windows', () => {
    expect(mgr.primaryDip()).toEqual({ x: 960, y: 540 });
  });

  it('finds the display under a physical point and maps it into that overlay', () => {
    expect(mgr.displayAt({ x: 1920 + 10, y: 10 })).toEqual({ id: 2, rect: { x: 1920, y: 0, w: 1280, h: 1024 } });
    expect(mgr.toLocal({ x: 1920 + 10, y: 30 })).toEqual({ displayId: 2, x: 10, y: 30 });
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

describe('OverlayManager kept ping', () => {
  const keepOn = () => mgr.updateSettings(overlaySettings({ ...DEFAULT_SETTINGS, keepLastPing: true }));

  it('keeps a click ping and drops the one kept on the other display', () => {
    keepOn();
    mgr.handle({ type: 'click', x: 1920 + 300, y: 400, wheel: 'ping' });
    expect(sent(1)).toEqual([['ping:spawn', { id: DEFAULT_SETTINGS.clickPingId, x: 300, y: 400, keep: true }]]);
    expect(sent(0)).toEqual([['ping:unkeep', null]]);
  });

  it('drops the kept ping on the other displays when a wheel ping is reported', () => {
    keepOn();
    h.handlers.get(OVERLAY_PINGED)!({ sender: h.windows[1].webContents }, { id: 'danger', x: 1, y: 2 });
    expect(sent(0)).toEqual([['ping:unkeep', null]]);
    expect(sent(1)).toEqual([]);
  });

  it('drops it everywhere on pause, and sends nothing while the setting is off', () => {
    mgr.dropKeptPings();
    mgr.handle({ type: 'click', x: 50, y: 60, wheel: 'ping' });
    expect(sent(0)).toEqual([['ping:spawn', { id: DEFAULT_SETTINGS.clickPingId, x: 50, y: 60 }]]);
    expect(sent(1)).toEqual([]);
    keepOn();
    mgr.dropKeptPings();
    expect(sent(1)).toEqual([['ping:unkeep', null]]);
  });

  it('never keeps a room member’s ping or a preview', () => {
    keepOn();
    mgr.spawnRemote({ displayId: 2, x: 1, y: 1, id: 'danger', tag: { name: 'Bot', color: 0 } });
    mgr.previewPing('danger');
    expect(sent(1)).toEqual([['ping:spawn', { id: 'danger', x: 1, y: 1, tag: { name: 'Bot', color: 0 } }]]);
    expect(sent(0)).toEqual([['ping:spawn', { id: 'danger', x: 960, y: 540 }]]);
  });
});

describe('OverlayManager remote and preview emotes', () => {
  it('shows a room member\'s emote on the target display with their tag, and clears theirs on the others', () => {
    mgr.spawnRemoteEmote({ displayId: 2, x: 5, y: 6, ref: 'gg_heart', peer: 'peer-1', tag: { name: 'Bob', color: 2 } });
    expect(resolveArt).toHaveBeenCalledWith('gg_heart', true, 'peer-1');
    expect(sent(1)).toEqual([['emote:spawn', { owner: 'peer-1', art: art('gg_heart', true), x: 5, y: 6, tag: { name: 'Bob', color: 2 } }]]);
    expect(sent(0)).toEqual([['emote:clear', { owner: 'peer-1' }]]);
  });

  it('plays a room member’s custom emote with the effect on their message, over what we would have picked', () => {
    const url = `lolping://emotes/${'a'.repeat(32)}.webp`;
    const cached: EmoteArt = { kind: 'custom', url, animated: false, fx: 0 };
    const mine: EmoteArt = { kind: 'custom', url, animated: false, fx: 2 };
    resolveArt.mockReturnValueOnce(cached).mockReturnValueOnce(mine);
    mgr.spawnRemoteEmote({ displayId: 1, x: 1, y: 1, ref: `c:${'a'.repeat(32)}`, fx: 5, peer: 'peer-1', tag: { name: 'Bob', color: 2 } });
    mgr.spawnRemoteEmote({ displayId: 1, x: 1, y: 1, ref: `c:${'a'.repeat(32)}`, peer: 'peer-1', tag: { name: 'Bob', color: 2 } });
    expect(sent(0)[0][1]).toMatchObject({ art: { kind: 'custom', fx: 5 } }); // the sender's pick, not the cache's plain pop
    expect(sent(0)[1][1]).toMatchObject({ art: { kind: 'custom', fx: 0 } }); // no fx on the message: the sender's plain pop, whatever we stored
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

describe('OverlayManager window bounds', () => {
  it('leaves the bottom row of each display uncovered on Windows, so the taskbar does not see a full-screen app', () => {
    for (const w of h.windows) w.emit('ready-to-show');
    expect(h.windows.map((w) => w.bounds)).toEqual([
      { x: 0, y: 0, width: 1920, height: 1079 },
      { x: 1920, y: 0, width: 1280, height: 1023 },
    ]);
  });

  it('keeps pings where they were placed, since the window still starts at the display\'s corner', () => {
    mgr.handle({ type: 'click', x: 1920 + 300, y: 400, wheel: 'ping' });
    expect(sent(1)).toEqual([['ping:spawn', { id: DEFAULT_SETTINGS.clickPingId, x: 300, y: 400 }]]);
  });

  it('covers the whole display on macOS', async () => {
    h.windows.length = 0;
    h.isMac = true;
    vi.resetModules();
    const { OverlayManager } = await import('../../src/main/overlayManager');
    new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt).start();
    for (const w of h.windows) w.emit('ready-to-show');
    expect(h.windows.map((w) => w.bounds)).toEqual([
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 1280, height: 1024 },
    ]);
  });

  it('covers the whole display on Linux, where the taskbar workaround does not apply', async () => {
    h.windows.length = 0;
    h.isLinux = true;
    vi.resetModules();
    const { OverlayManager } = await import('../../src/main/overlayManager');
    new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt).start();
    for (const w of h.windows) w.emit('ready-to-show');
    expect(h.windows.map((w) => w.bounds)).toEqual([
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 1280, height: 1024 },
    ]);
  });

  it('keeps every overlay out of Mission Control on macOS, and leaves Windows alone', async () => {
    expect(h.windows.map((w) => w.hiddenInMissionControl)).toEqual([false, false]);
    h.windows.length = 0;
    h.isMac = true;
    vi.resetModules();
    const { OverlayManager } = await import('../../src/main/overlayManager');
    new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt).start();
    expect(h.windows.map((w) => w.hiddenInMissionControl)).toEqual([true, true]);
  });
});

describe('OverlayManager stale display bounds', () => {
  it('rebuilds before a wheel when a game switched the display mode without a metrics-changed event', () => {
    for (const w of h.windows) w.emit('ready-to-show');
    h.setDisplayBounds(1, { height: 1440 }); // the display got taller; Electron never told the manager
    mgr.handle({ type: 'wheelOpen', x: 900, y: 1400, wheel: 'emote' });
    expect(h.windows[0].bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1439 });
    expect(sent(0)).toEqual([['wheel:open', { x: 900, y: 1400, wheel: 'emote' }]]);
  });

  it('rebuilds before a click ping placed from screen coordinates, too', () => {
    for (const w of h.windows) w.emit('ready-to-show');
    h.setDisplayBounds(2, { width: 1280, height: 800 });
    mgr.handle({ type: 'click', x: 1920 + 300, y: 400, wheel: 'ping' });
    expect(h.windows[1].bounds).toEqual({ x: 1920, y: 0, width: 1280, height: 799 });
    expect(sent(1)).toEqual([['ping:spawn', { id: DEFAULT_SETTINGS.clickPingId, x: 300, y: 400 }]]);
  });

  it('re-checks when something appears with no gesture ahead of it, like a room member\'s ping', () => {
    for (const w of h.windows) w.emit('ready-to-show');
    h.setDisplayBounds(2, { height: 900 });
    mgr.spawnRemote({ displayId: 2, x: 10, y: 10, id: 'danger', tag: { name: 'Bot', color: 0 } });
    expect(h.windows[1].bounds).toEqual({ x: 1920, y: 0, width: 1280, height: 899 });
    expect(sent(1)).toEqual([['ping:spawn', { id: 'danger', x: 10, y: 10, tag: { name: 'Bot', color: 0 } }]]);
  });

  it('rebuilds when only the scale changed, as when a 4K panel at 200% drops to 1080p at 100%', () => {
    for (const w of h.windows) w.emit('ready-to-show');
    h.displays[0].scaleFactor = 2; // same DIP bounds, so only the scale tells the modes apart
    mgr.handle({ type: 'wheelOpen', x: 900, y: 400, wheel: 'ping' });
    expect(sent(0)).toEqual([['wheel:open', { x: 450, y: 200, wheel: 'ping' }]]);
  });

  it('leaves a Retina display alone on macOS, whose maps are in DIPs at scale 1', async () => {
    h.isMac = true;
    h.displays[0].scaleFactor = 2;
    vi.resetModules();
    const { OverlayManager } = await import('../../src/main/overlayManager');
    const mac = new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt);
    mac.start();
    const rebuilt = vi.fn();
    mac.on('displays', rebuilt);
    mac.handle({ type: 'wheelOpen', x: 100, y: 200, wheel: 'ping' });
    mac.toast('t', 'b');
    expect(rebuilt).not.toHaveBeenCalled();
  });

  it('leaves the overlays alone while every display is as the last rebuild saw it', () => {
    for (const w of h.windows) w.emit('ready-to-show');
    const bounds = h.windows[0].bounds;
    mgr.handle({ type: 'wheelOpen', x: 100, y: 200, wheel: 'ping' });
    mgr.toast('t', 'b');
    expect(h.windows[0].bounds).toBe(bounds); // untouched: no rebuild happened
    expect(sent(0)).toEqual([['wheel:open', { x: 100, y: 200, wheel: 'ping' }], ['toast:show', { title: 't', body: 'b' }]]);
  });
});

describe('OverlayManager z-order', () => {
  /** Levels set on each window after it was created. */
  const raised = (): string[][] => h.windows.map((w) => w.onTop.slice(1));

  it('puts the overlay back on top on Windows before it shows a wheel, a ping, an emote or a toast', () => {
    mgr.handle({ type: 'wheelOpen', x: 100, y: 200, wheel: 'ping' });
    mgr.spawnRemote({ displayId: 2, x: 1, y: 1, id: 'danger', tag: { name: 'Bot', color: 0 } });
    mgr.previewEmote('okay');
    mgr.toast('t', 'b');
    expect(raised()).toEqual([['screen-saver', 'screen-saver', 'screen-saver'], ['screen-saver']]);
  });

  it('leaves the z-order alone while a wheel moves, ends, or settings change', () => {
    mgr.handle({ type: 'wheelOpen', x: 100, y: 200, wheel: 'ping' });
    mgr.handle({ type: 'wheelMove', x: 110, y: 210, wheel: 'ping' });
    mgr.handle({ type: 'wheelRelease', x: 120, y: 220, wheel: 'ping' });
    mgr.updateSettings(overlaySettings(DEFAULT_SETTINGS));
    expect(raised()).toEqual([['screen-saver'], []]);
  });

  it('never touches it again on Linux, where the Windows 10 z-order fix does not apply', async () => {
    h.windows.length = 0;
    h.isLinux = true;
    vi.resetModules();
    const { OverlayManager } = await import('../../src/main/overlayManager');
    const linux = new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt);
    linux.start();
    linux.handle({ type: 'wheelOpen', x: 100, y: 200, wheel: 'ping' });
    linux.previewPing('danger');
    expect(raised()).toEqual([[], []]);
  });

  it('never touches it again on macOS, where the panel stays on top', async () => {
    h.windows.length = 0;
    h.isMac = true;
    vi.resetModules();
    const { OverlayManager } = await import('../../src/main/overlayManager');
    const mac = new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt);
    mac.start();
    mac.handle({ type: 'wheelOpen', x: 100, y: 200, wheel: 'ping' });
    mac.previewPing('danger');
    expect(raised()).toEqual([[], []]);
  });
});

describe('parkedBounds', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const overlay = { x: 0, y: 0, width: 1920, height: 1079 };

  it('moves the overlay above its display, leaving one DIP on it so it keeps that display’s scale', () => {
    expect(parkedBounds(display, overlay, [{ x: 1920, y: 0, width: 1280, height: 1024 }]))
      .toEqual({ x: 0, y: -1078, width: 1920, height: 1079 });
  });

  it('goes below, left or right when the side before it borders another display', () => {
    const above = { x: 0, y: -1080, width: 1920, height: 1080 };
    const below = { x: 0, y: 1080, width: 1920, height: 1080 };
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    expect(parkedBounds(display, overlay, [above])).toEqual({ x: 0, y: 1079, width: 1920, height: 1079 });
    expect(parkedBounds(display, overlay, [above, below])).toEqual({ x: -1919, y: 0, width: 1920, height: 1079 });
    expect(parkedBounds(display, overlay, [above, below, left])).toEqual({ x: 1919, y: 0, width: 1920, height: 1079 });
  });

  it('gives up when every side borders another display', () => {
    const around = [
      { x: 0, y: -1080, width: 1920, height: 1080 }, { x: 0, y: 1080, width: 1920, height: 1080 },
      { x: -1920, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1920, height: 1080 },
    ];
    expect(parkedBounds(display, overlay, around)).toBeNull();
  });
});

describe('OverlayManager idle windows', () => {
  const idle = (i: number, value: unknown): void => h.handlers.get(OVERLAY_IDLE)!({ sender: h.windows[i].webContents }, value);
  const shownAtStart = (): void => {
    for (const w of h.windows) w.emit('ready-to-show');
  };
  const parked = { x: 0, y: -1078, width: 1920, height: 1079 };
  const overDisplay = { x: 0, y: 0, width: 1920, height: 1079 };

  it('parks an empty overlay on Windows off its display, shown, so screenshot tools see the windows under it', () => {
    shownAtStart();
    idle(0, true);
    expect(h.windows.map((w) => w.visible)).toEqual([true, true]);
    expect(h.windows[0].bounds).toEqual(parked);
    expect(h.windows[1].bounds).toEqual({ x: 1920, y: 0, width: 1280, height: 1023 });
  });

  it('puts it back over its display, back on top, as soon as its page draws something', () => {
    shownAtStart();
    idle(0, true);
    const levels = h.windows[0].onTop.length;
    idle(0, false);
    expect(h.windows[0].bounds).toEqual(overDisplay);
    expect(h.windows[0].onTop.slice(levels)).toEqual(['screen-saver']);
  });

  it('parks an overlay whose page said it was empty before the window was ready to show', () => {
    idle(0, true);
    shownAtStart();
    expect(h.windows[0].visible).toBe(true);
    expect(h.windows[0].bounds).toEqual(parked);
  });

  it('keeps a parked overlay parked when the displays change under it', () => {
    shownAtStart();
    idle(0, true);
    h.setDisplayBounds(1, { height: 1200 });
    mgr.toast('t', 'b'); // something new to draw makes the manager notice; the page has not drawn it yet
    expect(h.windows[0].bounds).toEqual({ x: 0, y: -1198, width: 1920, height: 1199 });
  });

  it('ignores a malformed report', () => {
    shownAtStart();
    idle(0, 'yes');
    idle(0, 1);
    expect(h.windows[0].bounds).toEqual(overDisplay);
  });

  it('leaves the overlays over their displays on macOS and Linux', async () => {
    for (const platform of ['mac', 'linux'] as const) {
      h.windows.length = 0;
      h.handlers.clear();
      h.isMac = platform === 'mac';
      h.isLinux = platform === 'linux';
      vi.resetModules();
      const { OverlayManager } = await import('../../src/main/overlayManager');
      new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt).start();
      shownAtStart();
      idle(0, true);
      expect(h.windows[0].bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    }
  });
});

describe('OverlayManager capture exclusion', () => {
  it('keeps every overlay out of a capture on Windows and lets them back in after', () => {
    mgr.setCaptureExcluded(true);
    expect(h.windows.map((w) => w.contentProtection)).toEqual([[true], [true]]);
    mgr.setCaptureExcluded(false);
    expect(h.windows.map((w) => w.contentProtection)).toEqual([[true, false], [true, false]]);
  });

  it('excludes an overlay built for a display that appears mid-capture', () => {
    mgr.setCaptureExcluded(true);
    h.displays.push({ id: 3, bounds: { x: 3200, y: 0, width: 800, height: 600 }, scaleFactor: 1 });
    mgr.handle({ type: 'wheelOpen', x: 10, y: 10, wheel: 'ping' }); // the next gesture finds the new display
    expect(h.windows).toHaveLength(3);
    expect(h.windows[2].contentProtection).toEqual([true]);
  });

  it('leaves the overlays alone on macOS and Linux, whose capture leaves lolPing out by itself', async () => {
    for (const platform of ['mac', 'linux'] as const) {
      h.windows.length = 0;
      h.isMac = platform === 'mac';
      h.isLinux = platform === 'linux';
      vi.resetModules();
      const { OverlayManager } = await import('../../src/main/overlayManager');
      const other = new OverlayManager(overlaySettings(DEFAULT_SETTINGS), resolveArt);
      other.start();
      other.setCaptureExcluded(true);
      expect(h.windows.map((w) => w.contentProtection)).toEqual([[], []]);
    }
  });
});
