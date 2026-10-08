import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trayUpdateHandlers } from '../../src/main/trayUpdate';
import { DamagedDownloadError, Updater, type UpdateBackend, type UpdateInfo } from '../../src/main/updater';
import { strings, type Lang } from '../../src/shared/i18n';
import { updateErrorText } from '../../src/shared/update';

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

/** A backend whose calls settle when the test says so. */
class FakeBackend implements UpdateBackend {
  checks: Deferred<UpdateInfo | null>[] = [];
  downloads: Deferred<void>[] = [];
  installs: Deferred<void>[] = [];

  check(): Promise<UpdateInfo | null> {
    const d = deferred<UpdateInfo | null>();
    this.checks.push(d);
    return d.promise;
  }

  download(): Promise<void> {
    const d = deferred<void>();
    this.downloads.push(d);
    return d.promise;
  }

  install(): Promise<void> {
    const d = deferred<void>();
    this.installs.push(d);
    return d.promise;
  }
}

/** Lets the handlers' fire-and-forget promises settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let backend: FakeBackend;
let updater: Updater;
let lang: Lang;
let toasts: [string, string][];
let handlers: ReturnType<typeof trayUpdateHandlers>;

beforeEach(() => {
  backend = new FakeBackend();
  lang = 'en';
  toasts = [];
  updater = new Updater({
    backend,
    now: () => 1000,
    autoCheck: () => false,
    notifiedVersion: () => null,
    setNotifiedVersion: () => undefined,
    errorText: (kind, reason) => updateErrorText(strings(lang), kind, reason),
  });
  handlers = trayUpdateHandlers({ updater, toast: (title, body) => toasts.push([title, body]), text: () => strings(lang) });
});

/** The updater has found 0.5.1. */
async function haveUpdate(): Promise<void> {
  const p = updater.check(true);
  backend.checks[backend.checks.length - 1].resolve(INFO);
  await p;
  expect(updater.state.phase).toBe('available');
}

describe('tray Check for updates', () => {
  it('toasts "up to date" when there is no update', async () => {
    handlers.check();
    expect(toasts).toEqual([]); // nothing to say while it is checking
    backend.checks[0].resolve(null);
    await flush();
    expect(toasts).toEqual([['lolPing is up to date', '']]);
  });

  it('toasts the error when offline, rate-limited or timed out', async () => {
    handlers.check();
    backend.checks[0].reject(new Error('GitHub answered 403'));
    await flush();
    expect(toasts).toEqual([['Update error', 'Couldn’t check for updates: GitHub answered 403']]);
  });

  it('shows only the first line of a long reason, as the About card does', async () => {
    handlers.check();
    backend.checks[0].reject(new Error('connect ENOTFOUND api.github.com\n    at stack frames\n    at more'));
    await flush();
    expect(toasts).toEqual([['Update error', 'Couldn’t check for updates: connect ENOTFOUND api.github.com']]);
  });

  it('says nothing when it finds an update: the new-version toast and the menu item do', async () => {
    handlers.check();
    backend.checks[0].resolve(INFO);
    await flush();
    expect(updater.state.phase).toBe('available');
    expect(toasts).toEqual([]);
  });

  it('says nothing when a check is already running', async () => {
    const running = updater.check(false);
    handlers.check(); // ignored by the updater
    await flush();
    expect(backend.checks).toHaveLength(1);
    expect(toasts).toEqual([]);
    backend.checks[0].resolve(null);
    await running;
    await flush();
    expect(toasts).toEqual([]);
  });

  it('says nothing while a download is running', async () => {
    await haveUpdate();
    void updater.startUpdate();
    handlers.check();
    await flush();
    expect(updater.state.phase).toBe('downloading');
    expect(toasts).toEqual([]);
  });

  it('uses the language at the time of the toast', async () => {
    lang = 'zh-CN';
    handlers.check();
    backend.checks[0].resolve(null);
    await flush();
    expect(toasts).toEqual([[strings('zh-CN').upToDate, '']]);
  });

  it('toasts again on every check', async () => {
    handlers.check();
    backend.checks[0].resolve(null);
    await flush();
    handlers.check();
    backend.checks[1].resolve(null);
    await flush();
    expect(toasts).toHaveLength(2);
  });
});

describe('tray Update to …', () => {
  it('toasts the error when the download fails', async () => {
    await haveUpdate();
    handlers.start();
    await flush();
    expect(updater.state.phase).toBe('downloading');
    expect(toasts).toEqual([]);
    backend.downloads[0].reject(new Error('socket hang up'));
    await flush();
    expect(updater.state.phase).toBe('error');
    expect(toasts).toEqual([['Update error', 'The download failed. Try again. (socket hang up)']]);
  });

  it('toasts the damaged-download error', async () => {
    await haveUpdate();
    handlers.start();
    await flush();
    backend.downloads[0].reject(new DamagedDownloadError('The download does not match its published SHA-256'));
    await flush();
    expect(toasts).toEqual([['Update error', 'The download was damaged. Try again.']]);
  });

  it('toasts the error when the install fails', async () => {
    await haveUpdate();
    handlers.start();
    await flush();
    backend.downloads[0].resolve();
    await flush();
    expect(updater.state.phase).toBe('installing');
    expect(toasts).toEqual([]);
    backend.installs[0].reject(new Error('spawn failed'));
    await flush();
    expect(toasts).toEqual([['Update error', 'The update couldn’t be installed. Try again.']]);
  });

  it('says nothing when the install goes through', async () => {
    await haveUpdate();
    handlers.start();
    await flush();
    backend.downloads[0].resolve();
    await flush();
    backend.installs[0].resolve();
    await flush();
    expect(updater.state.phase).toBe('installing');
    expect(toasts).toEqual([]);
  });

  it('says nothing when quitting aborts the download', async () => {
    await haveUpdate();
    handlers.start();
    await flush();
    updater.stop();
    backend.downloads[0].reject(new Error('The download was cancelled'));
    await flush();
    expect(updater.state.phase).toBe('available');
    expect(toasts).toEqual([]);
  });

  it('does not repeat an old error when there is nothing to download', async () => {
    handlers.check();
    backend.checks[0].reject(new Error('GitHub answered 403'));
    await flush();
    expect(toasts).toHaveLength(1);
    handlers.start(); // the updater has no update to download and ignores it: the error on record is not a new one
    await flush();
    expect(toasts).toHaveLength(1);
  });
});
