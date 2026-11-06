import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomChatState } from '../../src/shared/ipc';
import { CHAT_CH } from '../../src/shared/ipc';
import { ROOM_CHAT_ACCELERATOR } from '../../src/shared/roomChat';

const env = vi.hoisted(() => ({
  windows: [] as unknown[], handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listener: new Map<string, (...args: unknown[]) => unknown>(),
  shortcut: null as (() => void) | null, free: true, registered: false,
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeContents extends Emitter {
    loading = true;
    sent: unknown[][] = [];
    open: (() => { action: string }) | null = null;
    send(...args: unknown[]): void { this.sent.push(args); }
    isLoadingMainFrame(): boolean { return this.loading; }
    setWindowOpenHandler(cb: () => { action: string }): void { this.open = cb; }
  }
  class FakeWindow extends Emitter {
    webContents = new FakeContents();
    destroyed = false;
    visible = false;
    bounds = { x: 0, y: 0, width: 620, height: 340 };
    constructor(readonly options: unknown) { super(); env.windows.push(this); }
    setAlwaysOnTop(): void {}
    isDestroyed(): boolean { return this.destroyed; }
    setBounds(bounds: typeof this.bounds): void { this.bounds = bounds; }
    getBounds(): typeof this.bounds { return this.bounds; }
    show(): void { this.visible = true; }
    focus(): void { this.emit('focus'); }
    hide(): void { this.visible = false; this.emit('blur'); }
    close(): void { this.visible = false; this.emit('blur'); this.destroy(); }
    destroy(): void { this.destroyed = true; this.emit('closed'); }
  }
  return {
    BrowserWindow: FakeWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 200 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    },
    ipcMain: {
      handle: (ch: string, cb: (...args: unknown[]) => unknown) => env.handlers.set(ch, cb),
      on: (ch: string, cb: (...args: unknown[]) => unknown) => env.listener.set(ch, cb),
      removeHandler: (ch: string) => env.handlers.delete(ch),
      removeListener: (ch: string) => env.listener.delete(ch),
    },
    globalShortcut: {
      register: (ch: string, cb: () => void) => {
        expect(ch).toBe(ROOM_CHAT_ACCELERATOR);
        if (!env.free) return false;
        env.shortcut = cb;
        env.registered = true;
        return true;
      },
      unregister: (ch: string) => {
        expect(ch).toBe(ROOM_CHAT_ACCELERATOR);
        env.registered = false;
        env.shortcut = null;
      },
    },
  };
});
vi.mock('../../src/main/paths', () => ({
  IS_MAC: false, IS_LINUX: false, preloadPath: () => 'chat.js',
  pageUrl: () => 'lolping://app/chat/index.html', loadPage: () => Promise.resolve(),
}));

import { RoomChatWindow, roomChatPlacement } from '../../src/main/roomChatWindow';

type FakeWindow = EventEmitter & {
  webContents: EventEmitter & { loading: boolean; sent: unknown[][]; open: (() => { action: string }) | null };
  visible: boolean; destroyed: boolean; bounds: { x: number; y: number; width: number; height: number };
  destroy(): void;
};
const win = (): FakeWindow => env.windows[0] as FakeWindow;
const loaded = (): void => { win().webContents.loading = false; win().webContents.emit('did-finish-load'); };
const invoke = (ch: string, sender: unknown, raw?: unknown): unknown => env.handlers.get(ch)?.({ sender }, raw);

beforeEach(() => {
  env.windows.length = 0;
  env.handlers.clear();
  env.listener.clear();
  env.shortcut = null;
  env.free = true;
  env.registered = false;
});

function setup() {
  let state: RoomChatState = { lang: 'en', code: 'PING-AAAAA-BBBBB', members: 1, history: [] };
  const sent: string[] = [];
  const focused: boolean[] = [];
  const fail = vi.fn();
  const chat = new RoomChatWindow({
    state: () => state,
    submit: (text) => { sent.push(text); return 'sent'; },
    focused: (on) => focused.push(on), shortcutFailed: fail,
  });
  return { chat, sent, focused, fail, state: (s: RoomChatState) => { state = s; } };
}

describe('RoomChatWindow', () => {
  it('takes no keys outside a room and toggles a live chat through its shortcut', () => {
    const { chat, focused } = setup();
    chat.sync(false, true);
    chat.toggle();
    expect(env.registered).toBe(false);
    expect(env.windows).toHaveLength(0);
    chat.sync(true, true);
    env.shortcut?.();
    expect(win().visible).toBe(false);
    loaded();
    expect(win().visible).toBe(true);
    expect(focused).toEqual([true]);
    env.shortcut?.();
    expect(win().visible).toBe(false);
    expect(focused).toEqual([true, false]);
    env.shortcut?.();
    expect(env.windows).toHaveLength(2);
    const reopened = env.windows[1] as FakeWindow;
    reopened.webContents.loading = false;
    reopened.webContents.emit('did-finish-load');
    expect(reopened.visible).toBe(true);
    chat.destroy();
  });

  it('hides immediately on pause or leave, even if the page finishes loading later', () => {
    const { chat, sent } = setup();
    chat.sync(true, true);
    chat.toggle();
    chat.sync(false, false);
    loaded();
    expect(win().visible).toBe(false);
    expect(env.registered).toBe(false);
    expect(invoke(CHAT_CH.submit, win().webContents, 'late')).toBe('unknown');
    expect(sent).toEqual([]);
    expect(invoke(CHAT_CH.get, win().webContents)).toBeNull();
    chat.destroy();
  });

  it('uses the existing send path without closing chat and validates sender and payload', () => {
    const { chat, sent } = setup();
    chat.sync(true, true);
    chat.toggle();
    loaded();
    expect(invoke(CHAT_CH.submit, {}, 'forged')).toBe('unknown');
    expect(invoke(CHAT_CH.submit, win().webContents, { text: 'bad' })).toBe('unknown');
    expect(invoke(CHAT_CH.submit, win().webContents, 'hello')).toBe('sent');
    expect(sent).toEqual(['hello']);
    expect(win().visible).toBe(true);
    expect(invoke(CHAT_CH.get, {})).toBeNull();
    chat.destroy();
  });

  it('releases keyboard suspension on blur, hide and renderer failure', () => {
    const { chat, focused } = setup();
    chat.sync(true, true);
    chat.toggle();
    loaded();
    win().emit('blur');
    expect(win().visible).toBe(true);
    win().emit('focus');
    win().webContents.emit('render-process-gone');
    expect(focused).toEqual([true, false, true, false]);
    expect(win().destroyed).toBe(true);
    chat.toggle();
    expect(env.windows).toHaveLength(2);
    chat.destroy();
  });

  it('reports an occupied shortcut once per activation without breaking other shortcuts', () => {
    env.free = false;
    const { chat, fail } = setup();
    chat.sync(true, true);
    chat.sync(true, true);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(env.registered).toBe(false);
    chat.sync(false, false);
    env.free = true;
    chat.sync(true, true);
    expect(env.registered).toBe(true);
    chat.destroy();
    expect(env.registered).toBe(false);
  });

  it('keeps a dragged position across toggles and pushes fresh history without refocusing', () => {
    const { chat, state, focused } = setup();
    chat.sync(true, true);
    chat.toggle();
    loaded();
    win().bounds = { x: 250, y: 300, width: 620, height: 340 };
    chat.hide();
    chat.toggle();
    const reopened = env.windows[1] as FakeWindow;
    reopened.webContents.loading = false;
    reopened.webContents.emit('did-finish-load');
    expect(reopened.bounds.x).toBe(250);
    expect(reopened.bounds.y).toBe(300);
    reopened.emit('blur');
    const next: RoomChatState = { lang: 'zh-CN', code: 'PING-AAAAA-BBBBB', members: 2, history: [
      { at: 1, kind: 'text', tag: null, text: 'hello' },
    ] };
    state(next);
    chat.update();
    expect(reopened.webContents.sent.at(-1)).toEqual([CHAT_CH.state, { ...next, draft: '' }]);
    expect(focused.at(-1)).toBe(false);
    chat.destroy();
  });

  it('ignores late load and focus events from a window that was already hidden', () => {
    const { chat, focused } = setup();
    chat.sync(true, true);
    chat.toggle();
    const old = win();
    chat.hide();
    chat.toggle();
    old.webContents.emit('did-finish-load');
    old.emit('focus');
    expect(old.visible).toBe(false);
    expect(focused).toEqual([]);
    const reopened = env.windows[1] as FakeWindow;
    reopened.webContents.loading = false;
    reopened.webContents.emit('did-finish-load');
    old.emit('blur');
    expect(focused).toEqual([true]);
    chat.destroy();
  });

  it('restores only a bounded draft from its own page and clears it on leave', () => {
    const { chat } = setup();
    chat.sync(true, true);
    chat.toggle();
    loaded();
    env.listener.get(CHAT_CH.draft)?.({ sender: {} }, 'forged');
    expect(invoke(CHAT_CH.get, win().webContents)).toMatchObject({ draft: '' });
    env.listener.get(CHAT_CH.draft)?.({ sender: win().webContents }, '😀'.repeat(121));
    chat.hide();
    chat.toggle();
    const reopened = env.windows[1] as FakeWindow;
    expect(invoke(CHAT_CH.get, reopened.webContents)).toMatchObject({ draft: '😀'.repeat(120) });
    chat.clearDraft();
    expect(invoke(CHAT_CH.get, reopened.webContents)).toMatchObject({ draft: '' });
    chat.destroy();
  });

  it('blocks other pages and new windows and removes every IPC handler on shutdown', () => {
    const { chat } = setup();
    chat.sync(true, true);
    chat.toggle();
    const preventDefault = vi.fn();
    win().webContents.emit('will-navigate', { url: 'https://example.com', preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(win().webContents.open?.()).toEqual({ action: 'deny' });
    chat.destroy();
    expect(env.handlers.size).toBe(0);
    expect(env.listener.size).toBe(0);
  });
});

describe('roomChatPlacement', () => {
  it('fits small work areas and negative-coordinate monitors', () => {
    expect(roomChatPlacement({ x: -800, y: -100, width: 400, height: 250 })).toEqual({
      x: -800, y: -100, width: 400, height: 250,
    });
    expect(roomChatPlacement({ x: 0, y: 0, width: 800, height: 600 }, { x: -900, y: 999, width: 620, height: 340 }))
      .toEqual({ x: 0, y: 260, width: 620, height: 340 });
  });
});
