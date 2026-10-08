import { autoUpdater, CancellationToken, type AppUpdater, type ProgressInfo } from 'electron-updater';
import { DamagedDownloadError, type UpdateBackend, type UpdateInfo } from './updater';

/** A check that hasn't answered by now has failed: electron-updater has no timeout of its own, so a hung request would hold `checking` forever. */
export const CHECK_TIMEOUT_MS = 30_000;

/**
 * How long "Restarting to update…" stays up before the app quits. quitAndInstall quits on the next tick and the quit destroys the
 * overlay windows, so without this wait the toast is sent but never painted.
 */
export const INSTALL_TOAST_MS = 1500;

const RELEASE_PAGE = 'https://github.com/darrenprx/lolPing/releases/tag/v';

export interface WinBackendDeps {
  /** LOLPING_UPDATE_TEST_URL: a folder that serves latest.yml, used instead of GitHub. */
  testUrl?: string;
  log(line: string): void;
  /** Shows "Restarting to update…" before the app quits. */
  toast(): void;
  /** Whether lolPing is already quitting (the user chose Quit during the toast wait). */
  isQuitting(): boolean;
}

const noop = (): void => undefined;

/** electron-updater's loggers get anything: a string, an Error, an object. */
function lineOf(message: unknown): string {
  if (message instanceof Error) return message.stack ?? message.message;
  return typeof message === 'string' ? message : String(message);
}

/**
 * Updates on Windows through electron-updater: it reads latest.yml from the newest GitHub release, downloads the installer
 * (checking its SHA-512, and deleting it on a mismatch) and runs it silently over the existing install.
 */
export class WinBackend implements UpdateBackend {
  /** `updater` is electron-updater's autoUpdater unless a test passes another. It is only touched here, so a Mac never creates one. */
  constructor(
    private readonly deps: WinBackendDeps,
    private readonly updater: AppUpdater = autoUpdater,
  ) {
    const u = this.updater;
    u.autoDownload = false; // nothing downloads until the user clicks Update
    u.autoInstallOnAppQuit = false; // and nothing installs by itself when lolPing quits
    u.logger = {
      info: (m) => this.deps.log(lineOf(m)),
      warn: (m) => this.deps.log(`warn: ${lineOf(m)}`),
      error: (m) => this.deps.log(`error: ${lineOf(m)}`),
    };
    // An EventEmitter throws on 'error' when nobody listens. electron-updater also rejects the call that failed, so this only logs.
    u.on('error', (err) => this.deps.log(`error: ${lineOf(err)}`));
    if (this.deps.testUrl) {
      u.setFeedURL({ provider: 'generic', url: this.deps.testUrl });
      u.forceDevUpdateConfig = true; // a development build has no app-update.yml
    }
  }

  async check(): Promise<UpdateInfo | null> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`GitHub did not answer within ${CHECK_TIMEOUT_MS / 1000} seconds`)), CHECK_TIMEOUT_MS);
    });
    const request = (async () => this.updater.checkForUpdates())();
    request.catch(noop); // a check that fails after the timeout has nobody left to tell
    let result: Awaited<typeof request>;
    try {
      result = await Promise.race([request, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    if (!result?.isUpdateAvailable) return null; // electron-updater's own version comparison decides
    const version: unknown = result.updateInfo?.version;
    if (typeof version !== 'string' || version === '') throw new Error('GitHub sent an unexpected answer');
    return { version, notesUrl: `${RELEASE_PAGE}${encodeURIComponent(version)}` };
  }

  async download(_info: UpdateInfo, onProgress: (percent: number) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const token = new CancellationToken();
    const onAbort = (): void => token.cancel();
    const onUpdate = (p: ProgressInfo): void => onProgress(Math.floor(p.percent));
    signal.addEventListener('abort', onAbort, { once: true });
    this.updater.on('download-progress', onUpdate);
    try {
      await this.updater.downloadUpdate(token);
    } catch (err) {
      // electron-updater deletes a file whose SHA-512 differs from latest.yml; the user is told it was damaged.
      if (!signal.aborted && (err as { code?: unknown } | null)?.code === 'ERR_CHECKSUM_MISMATCH') {
        throw new DamagedDownloadError(err instanceof Error ? err.message : 'The download does not match its published SHA-512');
      }
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.updater.removeListener('download-progress', onUpdate);
    }
  }

  async install(_info: UpdateInfo): Promise<void> {
    this.deps.toast();
    await new Promise<void>((resolve) => setTimeout(resolve, INSTALL_TOAST_MS)); // the update stays 'installing' meanwhile
    // Quit was chosen during the wait: lolPing's own shutdown is under way, and the installer must not start behind it.
    if (this.deps.isQuitting()) return;
    // quitAndInstall reports a failure to start the installer as an 'error' event, not by throwing: catch the event it raises.
    let failure: Error | undefined;
    const onError = (err: Error): void => {
      failure ??= err;
    };
    this.updater.on('error', onError);
    try {
      // Silent, into the existing folder, then relaunch. It quits the app, which runs lolPing's own shutdown (before-quit).
      this.updater.quitAndInstall(true, true);
    } finally {
      this.updater.removeListener('error', onError);
    }
    if (failure) throw failure;
  }
}
