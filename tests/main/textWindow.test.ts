import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  levels: [] as string[],
  isMac: false,
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWindow extends EventEmitter {
    private destroyed = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });

    setAlwaysOnTop(_flag: boolean, level: string): void {
      h.levels.push(level);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    close(): void {
      this.destroyed = true;
      this.emit('closed');
    }

    destroy(): void {
      this.close();
    }
  }

  return {
    BrowserWindow: FakeWindow,
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
});

vi.mock('../../src/main/paths', () => ({
  get IS_MAC() {
    return h.isMac;
  },
  loadPage: () => Promise.resolve(),
  pageUrl: () => 'lolping://app/text/index.html',
  preloadPath: () => 'preload.js',
}));

beforeEach(() => {
  vi.useFakeTimers();
  h.levels.length = 0;
  h.isMac = false;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function openTextBox(): Promise<void> {
  const { openTextWindow, closeTextWindow } = await import('../../src/main/textWindow');
  openTextWindow({ x: 100, y: 100 }, { placeholder: '', hint: '', unknown: '', votesOff: '' });
  expect(h.levels).toEqual([h.isMac ? 'status' : 'screen-saver']);
  closeTextWindow();
}

describe('text window always-on-top level', () => {
  it('leaves the macOS IME candidate window above the text box', async () => {
    h.isMac = true;
    await openTextBox();
  });

  it('keeps the existing top level on other platforms', async () => {
    await openTextBox();
  });
});
