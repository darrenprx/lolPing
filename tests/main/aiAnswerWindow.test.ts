import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { handlers, writeText } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, action: unknown) => unknown>(), writeText: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  let id = 0;
  return {
    clipboard: { writeText },
    ipcMain: { handle: (key: string, fn: (event: unknown, action: unknown) => unknown) => handlers.set(key, fn), removeHandler: (key: string) => handlers.delete(key) },
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), { id: ++id, mainFrame: { routingId: id }, send: vi.fn(), setWindowOpenHandler: vi.fn() });
      show = vi.fn();
      closed = false;
      close(): void { this.closed = true; this.emit('closed'); }
    },
  };
});
vi.mock('../../src/main/paths', () => ({ preloadPath: () => 'answer.js', loadPage: vi.fn().mockResolvedValue(undefined) }));
import { showAiAnswer } from '../../src/main/aiAnswerWindow';
afterEach(() => { vi.useRealTimers(); handlers.clear(); writeText.mockClear(); });
describe('persistent AI answer windows', () => {
  it('retains separate answers beyond notification timeouts until manually closed', () => {
    vi.useFakeTimers();
    const first = showAiAnswer('first') as unknown as EventEmitter & { closed: boolean; close(): void };
    const second = showAiAnswer('second') as unknown as { closed: boolean; close(): void };
    vi.advanceTimersByTime(120_000);
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);
    first.close();
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(handlers.size).toBe(1);
    second.close();
    expect(handlers.size).toBe(0);
  });
  it('only lets the owning main frame read, copy and close its answer', () => {
    const win = showAiAnswer('**raw Markdown**');
    const handler = handlers.get(`ai-answer:${win.webContents.id}`)!;
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    expect(handler(event, 'get')).toBe('**raw Markdown**');
    expect(() => handler({ sender: {}, senderFrame: win.webContents.mainFrame }, 'get')).toThrow('Unauthorized');
    expect(() => handler({ sender: win.webContents, senderFrame: { routingId: -1 } }, 'get')).toThrow('Unauthorized');
    handler(event, 'copy');
    expect(writeText).toHaveBeenCalledWith('**raw Markdown**');
    handler(event, 'close');
    expect(handlers.size).toBe(0);
  });
  it('blocks navigation and webviews', () => {
    const win = showAiAnswer('answer');
    const preventDefault = vi.fn();
    win.webContents.emit('will-navigate', { preventDefault });
    win.webContents.emit('will-attach-webview', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    win.close();
  });
});
