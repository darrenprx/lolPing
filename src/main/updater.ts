import { EventEmitter } from 'node:events';
import type { UpdateState } from '../shared/update';

export interface UpdateInfo {
  version: string;
  notesUrl: string;
}

/** What differs per platform: where updates come from, how a file is fetched and verified, how the new version is started. */
export interface UpdateBackend {
  /** The newer release, or null. Rejects when the check itself failed. */
  check(): Promise<UpdateInfo | null>;
  /** Fetches and verifies the update. Aborting rejects; a failed verification rejects with DamagedDownloadError. */
  download(info: UpdateInfo, onProgress: (percent: number) => void, signal: AbortSignal): Promise<void>;
  /** Starts the update. The app quits or restarts as part of it, so a resolved promise is not the end of the process. */
  install(info: UpdateInfo): Promise<void>;
}

export interface UpdaterDeps {
  backend: UpdateBackend;
  now(): number;
  autoCheck(): boolean;
  notifiedVersion(): string | null;
  setNotifiedVersion(v: string): void;
  /** Error text for the UI, already translated. */
  errorText(kind: 'check' | 'download' | 'damaged' | 'install', reason: string): string;
}

export const FIRST_CHECK_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Thrown by a backend when the file doesn't match its published hash, or has none (Mac). */
export class DamagedDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DamagedDownloadError';
  }
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The update state machine: a schedule of automatic checks, manual checks, one download at a time, then the install.
 * The schedule is a chain of timeouts re-armed after each check finishes, so checks never overlap and never run in a burst
 * (a sleeping computer or a hung request delays the next one instead of queueing several).
 * Events: 'state' (UpdateState), 'notify' (version: a newly found version, once), 'installing' (version).
 * A listener that throws is logged and skipped: it can't break the state machine or the listeners after it.
 */
export class Updater extends EventEmitter {
  private current: UpdateState = { phase: 'idle', lastCheck: null };
  private lastCheck: number | null = null;
  /** The update that `startUpdate` downloads: set by a check, kept through a failed download so Retry has it. */
  private info: UpdateInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scheduled = false;
  private ticking = false;
  private download: AbortController | null = null;
  /** Bumped by stop() so a check still in flight is dropped when it settles. */
  private epoch = 0;

  constructor(private readonly deps: UpdaterDeps) {
    super();
  }

  get state(): UpdateState {
    return this.current;
  }

  /**
   * The release notes link of the update that was found, or null when none is known. Unlike `state`, it is still there while
   * that update downloads and after its download or install failed, which is when "What's new" is the way to fetch it by hand.
   */
  get notesUrl(): string | null {
    return this.info?.notesUrl ?? null;
  }

  /** Schedules the first automatic check when automatic checks are on. */
  start(): void {
    if (this.deps.autoCheck()) this.setAutoCheck(true);
  }

  /** Starts or stops the automatic schedule. Turning it on checks again in 10 s. */
  setAutoCheck(on: boolean): void {
    if (!on) {
      this.scheduled = false;
      this.disarm();
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    if (!this.ticking) this.arm(FIRST_CHECK_MS);
  }

  /**
   * Looks for a newer version. Does nothing while another check, a download or an install is running. Never rejects.
   * An automatic check also leaves alone an update that is already waiting for the user (or whose download failed).
   */
  async check(manual: boolean): Promise<void> {
    const s = this.current;
    if (s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'installing') return;
    if (!manual && (s.phase === 'available' || (s.phase === 'error' && s.retry === 'download'))) return;

    const epoch = this.epoch;
    this.setState({ phase: 'checking', manual });
    let found: UpdateInfo | null;
    try {
      found = await this.deps.backend.check();
    } catch (err) {
      if (epoch !== this.epoch) return;
      // An automatic check that fails stays quiet; the next one is already coming.
      this.setState(manual
        ? { phase: 'error', message: this.deps.errorText('check', reasonOf(err)), retry: 'check' }
        : { phase: 'idle', lastCheck: this.lastCheck });
      return;
    }
    if (epoch !== this.epoch) return;

    this.lastCheck = this.deps.now();
    if (!found) {
      this.info = null;
      this.setState({ phase: 'idle', lastCheck: this.lastCheck });
      return;
    }
    this.info = { version: found.version, notesUrl: found.notesUrl };
    this.setState({ phase: 'available', version: found.version, notesUrl: found.notesUrl });
    try {
      if (this.deps.notifiedVersion() !== found.version) {
        this.deps.setNotifiedVersion(found.version);
        this.publish('notify', found.version);
      }
    } catch {
      // Announcing is a nicety: a settings file that can't be written must not break the check.
    }
  }

  /** Downloads, then installs. Only from `available` or after a failed download: a second call while one runs does nothing. */
  async startUpdate(): Promise<void> {
    const s = this.current;
    const info = this.info;
    if (!info || !(s.phase === 'available' || (s.phase === 'error' && s.retry === 'download'))) return;

    const abort = new AbortController();
    this.download = abort;
    this.setState({ phase: 'downloading', version: info.version, percent: 0 });
    try {
      await this.deps.backend.download(info, (percent) => this.onProgress(abort, info.version, percent), abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return; // stop() already put the state back
      if (this.download === abort) this.download = null;
      const kind = err instanceof DamagedDownloadError ? 'damaged' : 'download';
      this.setState({ phase: 'error', message: this.deps.errorText(kind, reasonOf(err)), retry: 'download' });
      return;
    }
    // A download that stop() aborted can settle after a newer one has started: only clear the controller that is ours.
    if (this.download === abort) this.download = null;
    if (abort.signal.aborted) return;

    this.setState({ phase: 'installing', version: info.version });
    this.publish('installing', info.version);
    try {
      await this.deps.backend.install(info);
    } catch (err) {
      this.setState({ phase: 'error', message: this.deps.errorText('install', reasonOf(err)), retry: 'download' });
    }
  }

  /** Clears the schedule, drops a check in flight and aborts a download (the update is waiting again). An install is left alone. */
  stop(): void {
    this.scheduled = false;
    this.disarm();
    this.epoch++;
    if (this.current.phase === 'checking') this.setState({ phase: 'idle', lastCheck: this.lastCheck });
    const abort = this.download;
    if (!abort) return;
    this.download = null;
    abort.abort();
    if (this.info) this.setState({ phase: 'available', version: this.info.version, notesUrl: this.info.notesUrl });
  }

  private onProgress(abort: AbortController, version: string, raw: number): void {
    if (abort.signal.aborted || this.current.phase !== 'downloading' || !Number.isFinite(raw)) return;
    const percent = Math.min(100, Math.max(0, Math.floor(raw)));
    if (percent === this.current.percent) return;
    this.setState({ phase: 'downloading', version, percent });
  }

  private setState(next: UpdateState): void {
    this.current = next;
    this.publish('state', next);
  }

  /** Like `emit`, but each listener runs on its own: one that throws (a window that is closing, say) is logged and the rest still run. */
  private publish(event: string, ...args: unknown[]): void {
    for (const listener of this.rawListeners(event)) {
      try {
        listener.apply(this, args);
      } catch (err) {
        console.error(`[update] a '${event}' listener failed:`, err);
      }
    }
  }

  private arm(ms: number): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.tick().catch(() => undefined); // tick() handles its own failures; this only keeps a listener's throw from going unhandled
    }, ms);
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One automatic check, then the next one 6 h after it finished, not after it started. */
  private async tick(): Promise<void> {
    this.timer = null;
    this.ticking = true;
    try {
      await this.check(false);
    } finally {
      this.ticking = false;
      if (this.scheduled) this.arm(CHECK_INTERVAL_MS);
    }
  }
}
