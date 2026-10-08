import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS, DamagedDownloadError, FIRST_CHECK_MS, Updater,
  type UpdateBackend, type UpdateInfo, type UpdaterDeps,
} from '../../src/main/updater';
import type { UpdateState } from '../../src/shared/update';

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
  downloads: { info: UpdateInfo; onProgress: (p: number) => void; signal: AbortSignal; done: Deferred<void> }[] = [];
  installs: { info: UpdateInfo; done: Deferred<void> }[] = [];

  check(): Promise<UpdateInfo | null> {
    const d = deferred<UpdateInfo | null>();
    this.checks.push(d);
    return d.promise;
  }

  download(info: UpdateInfo, onProgress: (p: number) => void, signal: AbortSignal): Promise<void> {
    const done = deferred<void>();
    this.downloads.push({ info, onProgress, signal, done });
    return done.promise;
  }

  install(info: UpdateInfo): Promise<void> {
    const done = deferred<void>();
    this.installs.push({ info, done });
    return done.promise;
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

let backend: FakeBackend;
let auto: boolean;
let notified: string | null;
let setNotified: ReturnType<typeof vi.fn<(v: string) => void>>;
let clock: number;
let updater: Updater;
let states: UpdateState[];
let notifies: string[];
let installings: string[];

function build(opts: { auto?: boolean; notified?: string | null } = {}): Updater {
  auto = opts.auto ?? true;
  notified = opts.notified ?? null;
  const deps: UpdaterDeps = {
    backend,
    now: () => clock,
    autoCheck: () => auto,
    notifiedVersion: () => notified,
    setNotifiedVersion: setNotified,
    errorText: (kind, reason) => `${kind}: ${reason}`,
  };
  const u = new Updater(deps);
  u.on('state', (s: UpdateState) => states.push(s));
  u.on('notify', (v: string) => notifies.push(v));
  u.on('installing', (v: string) => installings.push(v));
  return u;
}

/** Puts the updater in `available` for INFO through a manual check. */
async function makeAvailable(): Promise<void> {
  const p = updater.check(true);
  backend.checks.at(-1)!.resolve(INFO);
  await p;
}

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
  clock = 1_700_000_000_000;
  states = [];
  notifies = [];
  installings = [];
  setNotified = vi.fn((v: string) => {
    notified = v;
  });
  updater = build();
});

afterEach(() => {
  updater.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('schedule', () => {
  it('starts idle and never checked', () => {
    expect(updater.state).toEqual({ phase: 'idle', lastCheck: null });
  });

  it('first automatic check after 10 s, then every 6 h', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(backend.checks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checks).toHaveLength(1);
    backend.checks[0].resolve(null);
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(backend.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checks).toHaveLength(2);
    backend.checks[1].resolve(null);
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checks).toHaveLength(3);
  });

  it('uses the spec constants', () => {
    expect(FIRST_CHECK_MS).toBe(10_000);
    expect(CHECK_INTERVAL_MS).toBe(21_600_000);
  });

  it('no automatic checks when the setting is off', async () => {
    updater = build({ auto: false });
    updater.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(backend.checks).toHaveLength(0);
  });

  it('setAutoCheck(true) schedules a check at +10 s', async () => {
    updater = build({ auto: false });
    updater.start();
    updater.setAutoCheck(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(backend.checks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checks).toHaveLength(1);
  });

  it('setAutoCheck(false) stops the schedule, also while a check is pending', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(5_000);
    updater.setAutoCheck(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checks).toHaveLength(0);

    updater.setAutoCheck(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(backend.checks).toHaveLength(1);
    updater.setAutoCheck(false);
    backend.checks[0].resolve(null);
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checks).toHaveLength(1);
  });

  it('turning checks off and on during a check in flight leaves exactly one re-arm', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(backend.checks).toHaveLength(1);
    updater.setAutoCheck(false);
    updater.setAutoCheck(true); // no 10 s timer while the check is still running
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS * 3);
    expect(backend.checks).toHaveLength(1);
    backend.checks[0].resolve(null);
    await flush();
    expect(vi.getTimerCount()).toBe(1); // one 6 h timer, not two
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(backend.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checks).toHaveLength(2);
    backend.checks[1].resolve(null);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('turning checks off during a check in flight leaves no re-arm after it', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    updater.setAutoCheck(false);
    backend.checks[0].resolve(null);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() and setAutoCheck(true) twice do not double the schedule', async () => {
    updater.start();
    updater.start();
    updater.setAutoCheck(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(backend.checks).toHaveLength(1);
  });

  it('checks never overlap or pile up', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(backend.checks).toHaveLength(1); // still pending: GitHub hangs
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(backend.checks).toHaveLength(1);
    backend.checks[0].resolve(null);
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(backend.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checks).toHaveLength(2);
  });

  it('keeps the schedule going after a failed automatic check', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    backend.checks[0].reject(new Error('offline'));
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checks).toHaveLength(2);
  });

  it('an automatic check does not run while a manual check is pending, and re-arms for 6 h later', async () => {
    updater.start();
    const manual = updater.check(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(backend.checks).toHaveLength(1); // the manual one
    backend.checks[0].resolve(null);
    await manual;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(backend.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checks).toHaveLength(2);
  });

  it('automatic checks leave a waiting update alone', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    backend.checks[0].resolve(INFO);
    await flush();
    expect(updater.state.phase).toBe('available');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checks).toHaveLength(1);
    expect(updater.state).toEqual({ phase: 'available', version: '0.5.1', notesUrl: INFO.notesUrl });
  });

  it('automatic checks leave a failed download and its retry alone', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    backend.checks[0].resolve(INFO);
    await flush();
    const p = updater.startUpdate();
    backend.downloads[0].done.reject(new Error('reset'));
    await p;
    expect(updater.state).toMatchObject({ phase: 'error', retry: 'download' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checks).toHaveLength(1);
    expect(updater.state).toMatchObject({ phase: 'error', retry: 'download' });
  });

  it('an automatic check replaces a failed manual check', async () => {
    updater.start();
    const p = updater.check(true);
    backend.checks[0].reject(new Error('offline'));
    await p;
    expect(updater.state).toMatchObject({ phase: 'error', retry: 'check' });
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(backend.checks).toHaveLength(2);
    backend.checks[1].resolve(null);
    await flush();
    expect(updater.state.phase).toBe('idle');
  });
});

describe('checking', () => {
  it('a manual check goes checking then idle and records when it finished', async () => {
    const p = updater.check(true);
    expect(updater.state).toEqual({ phase: 'checking', manual: true });
    clock += 5;
    backend.checks[0].resolve(null);
    await p;
    expect(updater.state).toEqual({ phase: 'idle', lastCheck: clock });
    expect(states).toEqual([{ phase: 'checking', manual: true }, { phase: 'idle', lastCheck: clock }]);
  });

  it('an automatic check says it is automatic', async () => {
    const p = updater.check(false);
    expect(updater.state).toEqual({ phase: 'checking', manual: false });
    backend.checks[0].resolve(null);
    await p;
  });

  it('a found update becomes available with its notes link', async () => {
    const p = updater.check(true);
    backend.checks[0].resolve(INFO);
    await p;
    expect(updater.state).toEqual({ phase: 'available', version: '0.5.1', notesUrl: INFO.notesUrl });
  });

  it('a failed automatic check returns to idle silently', async () => {
    const p = updater.check(false);
    backend.checks[0].reject(new Error('offline'));
    await p;
    expect(updater.state).toEqual({ phase: 'idle', lastCheck: null });
    expect(states.map((s) => s.phase)).toEqual(['checking', 'idle']);
    expect(notifies).toEqual([]);
  });

  it('a failed check does not move lastCheck', async () => {
    const first = updater.check(true);
    backend.checks[0].resolve(null);
    await first;
    const stamp = clock;
    clock += 1000;
    const second = updater.check(false);
    backend.checks[1].reject(new Error('offline'));
    await second;
    expect(updater.state).toEqual({ phase: 'idle', lastCheck: stamp });
  });

  it('a failed manual check shows an error with retry check', async () => {
    const p = updater.check(true);
    backend.checks[0].reject(new Error('GitHub answered 403'));
    await p;
    expect(updater.state).toEqual({ phase: 'error', message: 'check: GitHub answered 403', retry: 'check' });
  });

  it('a manual check can be retried after an error', async () => {
    const p = updater.check(true);
    backend.checks[0].reject(new Error('offline'));
    await p;
    const again = updater.check(true);
    expect(updater.state).toEqual({ phase: 'checking', manual: true });
    backend.checks[1].resolve(null);
    await again;
    expect(updater.state.phase).toBe('idle');
  });

  it('a non-Error rejection still gives a reason', async () => {
    const p = updater.check(true);
    backend.checks[0].reject('boom');
    await p;
    expect(updater.state).toEqual({ phase: 'error', message: 'check: boom', retry: 'check' });
  });

  it('ignores a check while one is running', async () => {
    const first = updater.check(true);
    await updater.check(true);
    await updater.check(false);
    expect(backend.checks).toHaveLength(1);
    backend.checks[0].resolve(null);
    await first;
  });

  it('a manual check from available re-checks', async () => {
    await makeAvailable();
    const p = updater.check(true);
    expect(updater.state).toEqual({ phase: 'checking', manual: true });
    backend.checks[1].resolve({ version: '0.5.2', notesUrl: 'https://example.test/0.5.2' });
    await p;
    expect(updater.state).toEqual({ phase: 'available', version: '0.5.2', notesUrl: 'https://example.test/0.5.2' });
  });

  it('check() never rejects', async () => {
    setNotified.mockImplementation(() => {
      throw new Error('disk full');
    });
    const p = updater.check(true);
    backend.checks[0].resolve(INFO);
    await expect(p).resolves.toBeUndefined();
  });
});

describe('notesUrl', () => {
  it('is null until a check has found an update', () => {
    expect(updater.notesUrl).toBeNull();
  });

  it('is the notes link of the update that was found', async () => {
    await makeAvailable();
    expect(updater.notesUrl).toBe(INFO.notesUrl);
  });

  it('is kept while downloading and after a failed download or install, so What’s new can open it', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    expect(updater.notesUrl).toBe(INFO.notesUrl);
    backend.downloads[0].done.reject(new Error('socket hang up'));
    await p;
    expect(updater.state).toMatchObject({ phase: 'error', retry: 'download' });
    expect(updater.notesUrl).toBe(INFO.notesUrl);

    const again = updater.startUpdate();
    backend.downloads[1].done.resolve();
    await flush();
    backend.installs[0].done.reject(new Error('installer failed'));
    await again;
    expect(updater.state).toMatchObject({ phase: 'error', retry: 'download' });
    expect(updater.notesUrl).toBe(INFO.notesUrl);
  });

  it('follows a newer find, and is cleared when a later check finds nothing', async () => {
    await makeAvailable();
    const newer = updater.check(true);
    backend.checks[1].resolve({ version: '0.5.2', notesUrl: 'https://example.test/0.5.2' });
    await newer;
    expect(updater.notesUrl).toBe('https://example.test/0.5.2');
    const none = updater.check(true);
    backend.checks[2].resolve(null);
    await none;
    expect(updater.notesUrl).toBeNull();
  });

  it('survives a failed check, which says nothing about the update that was found', async () => {
    await makeAvailable();
    const p = updater.check(true);
    backend.checks[1].reject(new Error('offline'));
    await p;
    expect(updater.notesUrl).toBe(INFO.notesUrl);
  });
});

describe('notifying', () => {
  it('notifies once per version', async () => {
    const first = updater.check(true);
    backend.checks[0].resolve(INFO);
    await first;
    const second = updater.check(true);
    backend.checks[1].resolve(INFO);
    await second;
    expect(notifies).toEqual(['0.5.1']);
    expect(setNotified).toHaveBeenCalledTimes(1);
    expect(setNotified).toHaveBeenCalledWith('0.5.1');
  });

  it('does not notify a version that was already notified', async () => {
    updater = build({ notified: '0.5.1' });
    const p = updater.check(false);
    backend.checks[0].resolve(INFO);
    await p;
    expect(notifies).toEqual([]);
    expect(setNotified).not.toHaveBeenCalled();
    expect(updater.state.phase).toBe('available');
  });

  it('notifies again for a newer version', async () => {
    updater = build({ notified: '0.5.1' });
    const p = updater.check(false);
    backend.checks[0].resolve({ version: '0.5.2', notesUrl: 'https://example.test/0.5.2' });
    await p;
    expect(notifies).toEqual(['0.5.2']);
    expect(setNotified).toHaveBeenCalledWith('0.5.2');
  });

  it('notifies after the state is available', async () => {
    let seen: UpdateState | null = null;
    updater.on('notify', () => {
      seen = updater.state;
    });
    const p = updater.check(true);
    backend.checks[0].resolve(INFO);
    await p;
    expect(seen).toMatchObject({ phase: 'available', version: '0.5.1' });
  });

  it('a check that finds nothing does not notify', async () => {
    const p = updater.check(true);
    backend.checks[0].resolve(null);
    await p;
    expect(notifies).toEqual([]);
  });
});

describe('updating', () => {
  it('startUpdate downloads then installs', async () => {
    await makeAvailable();
    states = [];
    const p = updater.startUpdate();
    expect(updater.state).toEqual({ phase: 'downloading', version: '0.5.1', percent: 0 });
    expect(backend.downloads).toHaveLength(1);
    expect(backend.downloads[0].info).toEqual(INFO);
    expect(backend.downloads[0].signal.aborted).toBe(false);

    backend.downloads[0].onProgress(40);
    expect(updater.state).toEqual({ phase: 'downloading', version: '0.5.1', percent: 40 });
    backend.downloads[0].onProgress(100);
    expect(updater.state).toEqual({ phase: 'downloading', version: '0.5.1', percent: 100 });

    backend.downloads[0].done.resolve();
    await flush();
    expect(updater.state).toEqual({ phase: 'installing', version: '0.5.1' });
    expect(installings).toEqual(['0.5.1']);
    expect(backend.installs).toHaveLength(1);
    expect(backend.installs[0].info).toEqual(INFO);

    backend.installs[0].done.resolve();
    await p;
    expect(updater.state).toEqual({ phase: 'installing', version: '0.5.1' });
    expect(states.map((s) => s.phase)).toEqual(['downloading', 'downloading', 'downloading', 'installing']);
  });

  it('keeps progress between 0 and 100 and drops repeats and junk', async () => {
    await makeAvailable();
    void updater.startUpdate();
    states = [];
    const { onProgress } = backend.downloads[0];
    onProgress(12.9);
    onProgress(12.2);
    onProgress(-5);
    onProgress(Number.NaN);
    onProgress(250);
    expect(states).toEqual([
      { phase: 'downloading', version: '0.5.1', percent: 12 },
      { phase: 'downloading', version: '0.5.1', percent: 0 },
      { phase: 'downloading', version: '0.5.1', percent: 100 },
    ]);
  });

  it('startUpdate does nothing unless an update is waiting', async () => {
    await updater.startUpdate();
    expect(backend.downloads).toHaveLength(0);
    expect(updater.state.phase).toBe('idle');

    const p = updater.check(true);
    await updater.startUpdate();
    expect(backend.downloads).toHaveLength(0);
    backend.checks[0].resolve(null);
    await p;
  });

  it('startUpdate after a failed check does nothing', async () => {
    const p = updater.check(true);
    backend.checks[0].reject(new Error('offline'));
    await p;
    await updater.startUpdate();
    expect(backend.downloads).toHaveLength(0);
    expect(updater.state).toMatchObject({ phase: 'error', retry: 'check' });
  });

  it('ignores checks and repeat starts while downloading', async () => {
    await makeAvailable();
    const first = updater.startUpdate();
    const second = updater.startUpdate();
    await updater.check(true);
    await updater.check(false);
    await second;
    expect(backend.downloads).toHaveLength(1);
    expect(backend.checks).toHaveLength(1); // only the one that found the update
    expect(updater.state.phase).toBe('downloading');
    backend.downloads[0].done.resolve();
    await flush();
    backend.installs[0].done.resolve();
    await first;
  });

  it('ignores checks and repeat starts while installing', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    backend.downloads[0].done.resolve();
    await flush();
    expect(updater.state.phase).toBe('installing');
    await updater.startUpdate();
    await updater.check(true);
    expect(backend.downloads).toHaveLength(1);
    expect(backend.installs).toHaveLength(1);
    expect(backend.checks).toHaveLength(1);
    backend.installs[0].done.resolve();
    await p;
  });

  it('a download failure shows retry download', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    backend.downloads[0].done.reject(new Error('socket hang up'));
    await p;
    expect(updater.state).toEqual({ phase: 'error', message: 'download: socket hang up', retry: 'download' });
    expect(backend.installs).toHaveLength(0);
  });

  it('startUpdate from that error downloads again', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    backend.downloads[0].done.reject(new Error('socket hang up'));
    await p;
    const again = updater.startUpdate();
    expect(updater.state).toEqual({ phase: 'downloading', version: '0.5.1', percent: 0 });
    expect(backend.downloads).toHaveLength(2);
    expect(backend.downloads[1].info).toEqual(INFO);
    expect(backend.downloads[1].signal.aborted).toBe(false);
    backend.downloads[1].done.resolve();
    await flush();
    backend.installs[0].done.resolve();
    await again;
    expect(installings).toEqual(['0.5.1']);
  });

  it('a damaged download uses the damaged text', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    backend.downloads[0].done.reject(new DamagedDownloadError('sha256 mismatch'));
    await p;
    expect(updater.state).toEqual({ phase: 'error', message: 'damaged: sha256 mismatch', retry: 'download' });
  });

  it('an install rejection shows the install text with retry download', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    backend.downloads[0].done.resolve();
    await flush();
    backend.installs[0].done.reject(new Error('could not open the DMG'));
    await p;
    expect(updater.state).toEqual({ phase: 'error', message: 'install: could not open the DMG', retry: 'download' });
  });

  it('stop() aborts a running download', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    backend.downloads[0].onProgress(30);
    updater.stop();
    expect(backend.downloads[0].signal.aborted).toBe(true);
    expect(updater.state).toEqual({ phase: 'available', version: '0.5.1', notesUrl: INFO.notesUrl });
    // The aborted download settles as a rejection: no error state, no install.
    backend.downloads[0].done.reject(new Error('aborted'));
    await p;
    expect(updater.state.phase).toBe('available');
    expect(backend.installs).toHaveLength(0);
  });

  it('a download that finishes just after stop() is not installed', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    updater.stop();
    backend.downloads[0].done.resolve();
    await p;
    expect(backend.installs).toHaveLength(0);
    expect(installings).toEqual([]);
    expect(updater.state.phase).toBe('available');
  });

  it('progress after stop() changes nothing', async () => {
    await makeAvailable();
    void updater.startUpdate();
    updater.stop();
    backend.downloads[0].onProgress(77);
    expect(updater.state.phase).toBe('available');
  });

  it('an old download that settles late does not detach the controller of a newer one', async () => {
    await makeAvailable();
    const first = updater.startUpdate();
    updater.stop(); // the first download is aborted, but its backend call has not settled yet
    const second = updater.startUpdate();
    expect(backend.downloads).toHaveLength(2);
    backend.downloads[0].done.resolve(); // the first one finishes after all
    await first;
    expect(updater.state.phase).toBe('downloading');
    updater.stop(); // must still reach the second download
    expect(backend.downloads[1].signal.aborted).toBe(true);
    expect(updater.state.phase).toBe('available');
    backend.downloads[1].done.reject(new Error('aborted'));
    await second;
    expect(backend.installs).toHaveLength(0);
  });

  it('an old download that fails late does not detach the controller of a newer one', async () => {
    await makeAvailable();
    const first = updater.startUpdate();
    updater.stop();
    const second = updater.startUpdate();
    backend.downloads[0].done.reject(new Error('socket hang up'));
    await first;
    expect(updater.state.phase).toBe('downloading');
    updater.stop();
    expect(backend.downloads[1].signal.aborted).toBe(true);
    backend.downloads[1].done.reject(new Error('aborted'));
    await second;
  });

  it('stop() while installing leaves the install alone', async () => {
    await makeAvailable();
    const p = updater.startUpdate();
    backend.downloads[0].done.resolve();
    await flush();
    updater.stop(); // the graceful shutdown the Windows install runs
    expect(updater.state.phase).toBe('installing');
    backend.installs[0].done.reject(new Error('installer failed'));
    await p;
    expect(updater.state).toMatchObject({ phase: 'error', retry: 'download' });
  });
});

describe('stop', () => {
  it('clears the schedule', async () => {
    updater.start();
    updater.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checks).toHaveLength(0);
  });

  it('a check that finishes after stop() neither notifies nor re-arms', async () => {
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    updater.stop();
    backend.checks[0].resolve(INFO);
    await flush();
    expect(notifies).toEqual([]);
    expect(setNotified).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checks).toHaveLength(1);
  });

  it('is safe to call twice', () => {
    updater.stop();
    updater.stop();
  });

  it('leaves the state idle when it stops a check in flight', async () => {
    const p = updater.check(true);
    expect(updater.state).toEqual({ phase: 'checking', manual: true });
    updater.stop();
    expect(updater.state).toEqual({ phase: 'idle', lastCheck: null });
    backend.checks[0].resolve(INFO); // the late answer is dropped
    await p;
    expect(updater.state).toEqual({ phase: 'idle', lastCheck: null });
    expect(notifies).toEqual([]);
    expect(setNotified).not.toHaveBeenCalled();
  });

  it('a listener that throws cannot break stop() or leave the updater half stopped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await makeAvailable();
    const p = updater.startUpdate();
    const seen: UpdateState[] = [];
    updater.on('state', () => {
      throw new Error('settings window is gone');
    });
    updater.on('state', (s: UpdateState) => seen.push(s)); // a listener after the broken one still hears it
    expect(() => updater.stop()).not.toThrow();
    expect(backend.downloads[0].signal.aborted).toBe(true);
    expect(updater.state).toEqual({ phase: 'available', version: '0.5.1', notesUrl: INFO.notesUrl });
    expect(seen).toEqual([{ phase: 'available', version: '0.5.1', notesUrl: INFO.notesUrl }]);
    backend.downloads[0].done.reject(new Error('aborted'));
    await p;
    expect(updater.state.phase).toBe('available');
  });

  it('a listener that throws while a check is stopped still leaves the schedule cleared', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    updater.on('state', () => {
      throw new Error('boom');
    });
    expect(() => updater.stop()).not.toThrow();
    expect(updater.state).toEqual({ phase: 'idle', lastCheck: null });
    backend.checks[0].resolve(null);
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checks).toHaveLength(1);
  });

  it('a throwing listener cannot stop the install from starting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await makeAvailable();
    updater.on('installing', () => {
      throw new Error('boom');
    });
    updater.on('state', () => {
      throw new Error('boom');
    });
    const p = updater.startUpdate();
    backend.downloads[0].done.resolve();
    await flush();
    expect(backend.installs).toHaveLength(1);
    expect(updater.state.phase).toBe('installing');
    backend.installs[0].done.resolve();
    await p;
  });

  it('a throwing notify listener leaves the check complete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    updater.on('notify', () => {
      throw new Error('boom');
    });
    const p = updater.check(true);
    backend.checks[0].resolve(INFO);
    await expect(p).resolves.toBeUndefined();
    expect(updater.state.phase).toBe('available');
  });
});
