import { EventEmitter } from 'node:events';
import type { AppUpdater } from 'electron-updater';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_TIMEOUT_MS, INSTALL_TOAST_MS, WinBackend, type WinBackendDeps } from '../../src/main/updateWin';
import { DamagedDownloadError, type UpdateInfo } from '../../src/main/updater';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const INFO: UpdateInfo = { version: '0.5.1', notesUrl: 'https://github.com/darrenprx/lolPing/releases/tag/v0.5.1' };

/** The parts of electron-updater's AppUpdater that WinBackend uses. */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  forceDevUpdateConfig = false;
  logger: { info(m: unknown): void; warn(m: unknown): void; error(m: unknown): void } | null = null;
  setFeedURL = vi.fn();
  checks: Deferred<unknown>[] = [];
  downloads: { token: { cancelled: boolean; cancel(): void }; done: Deferred<string[]> }[] = [];
  quitAndInstall = vi.fn();

  checkForUpdates(): Promise<unknown> {
    const d = deferred<unknown>();
    this.checks.push(d);
    return d.promise;
  }

  downloadUpdate(token: { cancelled: boolean; cancel(): void }): Promise<string[]> {
    const done = deferred<string[]>();
    this.downloads.push({ token, done });
    return done.promise;
  }
}

let fake: FakeUpdater;
let logged: string[];
let toast: ReturnType<typeof vi.fn<() => void>>;
let quitting: boolean;

function make(over: Partial<WinBackendDeps> = {}): WinBackend {
  return new WinBackend({ log: (l) => logged.push(l), toast, isQuitting: () => quitting, ...over }, fake as unknown as AppUpdater);
}

const noAbort = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  fake = new FakeUpdater();
  logged = [];
  toast = vi.fn();
  quitting = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WinBackend setup', () => {
  it('configures without auto download', () => {
    make();
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(fake.setFeedURL).not.toHaveBeenCalled();
    expect(fake.forceDevUpdateConfig).toBe(false);
  });

  it('points electron-updater at the test URL and forces the update config', () => {
    make({ testUrl: 'http://127.0.0.1:8123' });
    expect(fake.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:8123' });
    expect(fake.forceDevUpdateConfig).toBe(true);
  });

  it('sends electron-updater log lines to the log', () => {
    make();
    fake.logger!.info('Checking for update');
    fake.logger!.warn('slow');
    fake.logger!.error(new Error('boom'));
    expect(logged[0]).toBe('Checking for update');
    expect(logged[1]).toBe('warn: slow');
    expect(logged[2]).toMatch(/^error: Error: boom/);
  });

  it('logs an error event instead of letting it throw', () => {
    make();
    expect(() => fake.emit('error', new Error('Cannot check for updates'))).not.toThrow();
    expect(logged.at(-1)).toMatch(/Cannot check for updates/);
  });
});

describe('WinBackend.check', () => {
  it('maps the result', async () => {
    const backend = make();
    const p = backend.check();
    fake.checks[0].resolve({ isUpdateAvailable: true, updateInfo: { version: '0.5.1' } });
    await expect(p).resolves.toEqual(INFO);
  });

  it('says there is no update when electron-updater finds none, or does nothing', async () => {
    const backend = make();
    const none = backend.check();
    fake.checks[0].resolve({ isUpdateAvailable: false, updateInfo: { version: '0.4.0' } });
    await expect(none).resolves.toBeNull();
    const inactive = backend.check();
    fake.checks[1].resolve(null);
    await expect(inactive).resolves.toBeNull();
  });

  it('a version that is not a string is a failed check', async () => {
    const backend = make();
    const p = backend.check();
    fake.checks[0].resolve({ isUpdateAvailable: true, updateInfo: { version: 5 } });
    await expect(p).rejects.toThrow('unexpected answer');
  });

  it('a failed check rejects with the reason', async () => {
    const backend = make();
    const p = backend.check();
    fake.checks[0].reject(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(p).rejects.toThrow('ERR_INTERNET_DISCONNECTED');
  });

  it('times out after 30 s', async () => {
    vi.useFakeTimers();
    expect(CHECK_TIMEOUT_MS).toBe(30_000);
    const backend = make();
    const p = backend.check();
    const settled = vi.fn();
    p.then(settled, settled);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toThrow('30 seconds');
  });

  it('a check that fails after the timeout leaves nothing unhandled', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const backend = make();
      const p = backend.check();
      p.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
      fake.checks[0].reject(new Error('too late'));
      await vi.advanceTimersByTimeAsync(10);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('an answer in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    const backend = make();
    const p = backend.check();
    fake.checks[0].resolve({ isUpdateAvailable: false, updateInfo: { version: '0.4.0' } });
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failure in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    const backend = make();
    const p = backend.check();
    fake.checks[0].reject(new Error('offline'));
    await expect(p).rejects.toThrow('offline');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('WinBackend.download', () => {
  it('reports progress and resolves when the download does', async () => {
    const backend = make();
    const progress: number[] = [];
    const p = backend.download(INFO, (n) => progress.push(n), noAbort());
    fake.emit('download-progress', { percent: 42.4 });
    fake.emit('download-progress', { percent: 99.9 });
    fake.emit('download-progress', { percent: 100 });
    expect(progress).toEqual([42, 99, 100]);
    fake.downloads[0].done.resolve(['C:\\cache\\lolPing-Setup-0.5.1.exe']);
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects when the download does', async () => {
    const backend = make();
    const p = backend.download(INFO, () => undefined, noAbort());
    fake.downloads[0].done.reject(new Error('socket hang up'));
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).message).toBe('socket hang up');
    expect(err).not.toBeInstanceOf(DamagedDownloadError);
  });

  it('a checksum mismatch is a damaged download', async () => {
    const backend = make();
    const p = backend.download(INFO, () => undefined, noAbort());
    fake.downloads[0].done.reject(Object.assign(new Error('sha512 checksum mismatch, expected a, got b'), { code: 'ERR_CHECKSUM_MISMATCH' }));
    await expect(p).rejects.toBeInstanceOf(DamagedDownloadError);
  });

  it('aborting cancels the token', async () => {
    const backend = make();
    const abort = new AbortController();
    const p = backend.download(INFO, () => undefined, abort.signal);
    expect(fake.downloads[0].token.cancelled).toBe(false);
    abort.abort();
    expect(fake.downloads[0].token.cancelled).toBe(true);
    fake.downloads[0].done.reject(new Error('cancelled'));
    await expect(p).rejects.toThrow('cancelled');
  });

  it('an aborted signal downloads nothing', async () => {
    const backend = make();
    const abort = new AbortController();
    abort.abort();
    await expect(backend.download(INFO, () => undefined, abort.signal)).rejects.toThrow();
    expect(fake.downloads).toHaveLength(0);
  });

  it('stops listening for progress once the download has ended', async () => {
    const backend = make();
    const abort = new AbortController();
    const progress: number[] = [];
    const first = backend.download(INFO, (n) => progress.push(n), abort.signal);
    fake.downloads[0].done.resolve([]);
    await first;
    expect(fake.listenerCount('download-progress')).toBe(0);
    abort.abort(); // after the end: nothing left to cancel
    expect(fake.downloads[0].token.cancelled).toBe(false);

    const second = backend.download(INFO, () => undefined, noAbort());
    fake.downloads[1].done.reject(new Error('x'));
    await second.catch(() => undefined);
    expect(fake.listenerCount('download-progress')).toBe(0);
  });
});

describe('WinBackend.install', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('toasts, gives the toast time to show, then quits and installs', async () => {
    const order: string[] = [];
    toast.mockImplementation(() => order.push('toast'));
    fake.quitAndInstall.mockImplementation(() => order.push('quitAndInstall'));
    const backend = make();
    const p = backend.install(INFO);
    expect(order).toEqual(['toast']);
    expect(INSTALL_TOAST_MS).toBe(1500);
    await vi.advanceTimersByTimeAsync(INSTALL_TOAST_MS - 1);
    expect(fake.quitAndInstall).not.toHaveBeenCalled(); // the app would quit before the toast is painted
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(order).toEqual(['toast', 'quitAndInstall']);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('does not start the installer when the app began quitting during the toast wait', async () => {
    const backend = make();
    const p = backend.install(INFO);
    await vi.advanceTimersByTimeAsync(INSTALL_TOAST_MS - 1);
    quitting = true; // Quit chosen from the tray while the toast shows
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeUndefined();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(fake.listenerCount('error')).toBe(1); // no listener left behind
  });

  it('is not settled while the toast is showing', async () => {
    const backend = make();
    const settled = vi.fn();
    void backend.install(INFO).then(settled, settled);
    await vi.advanceTimersByTimeAsync(INSTALL_TOAST_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('rejects when electron-updater reports that the installer could not start', async () => {
    fake.quitAndInstall.mockImplementation(() => {
      fake.emit('error', new Error("No update filepath provided, can't quit and install"));
    });
    const backend = make();
    const p = backend.install(INFO);
    const result = expect(p).rejects.toThrow('No update filepath');
    await vi.advanceTimersByTimeAsync(INSTALL_TOAST_MS);
    await result;
    expect(toast).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount('error')).toBe(1); // only the logging listener is left
  });

  it('rejects when quitAndInstall throws', async () => {
    fake.quitAndInstall.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const backend = make();
    const p = backend.install(INFO);
    const result = expect(p).rejects.toThrow('spawn failed');
    await vi.advanceTimersByTimeAsync(INSTALL_TOAST_MS);
    await result;
    expect(fake.listenerCount('error')).toBe(1);
  });
});
