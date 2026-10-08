import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { isNewer, isVersion } from '../shared/update';
import { DamagedDownloadError, type UpdateBackend, type UpdateInfo } from './updater';

export const RELEASES_API = 'https://api.github.com/repos/darrenprx/lolPing';
const API_TIMEOUT_MS = 15_000;

export interface MacBackendDeps {
  /** RELEASES_API, or LOLPING_UPDATE_TEST_URL. */
  apiBase: string;
  currentVersion: string;
  fetch: typeof fetch;
  downloadsDir: string;
  /** Brings lolPing to the front. A menu bar app is not the active app, and a dialog shown from the background can stay hidden. */
  focus(): void;
  showDialog(message: string): Promise<void>;
  /** shell.openPath: resolves to '' on success, otherwise an error message. */
  openPath(path: string): Promise<string>;
  /** The updateMacDialog string in the current language. */
  dialogText(): string;
  /** Quits lolPing through its graceful shutdown. */
  quit(): void;
}

/** The disk image of the newest release, as found by the last check. */
interface DmgAsset {
  version: string;
  name: string;
  url: string;
  /** Published size in bytes; 0 when the release doesn't say. */
  size: number;
  digest: string | null;
}

const noop = (): void => undefined;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const dmgName = (version: string): string => `lolPing-${version}-arm64.dmg`;

function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const { protocol } = new URL(v);
    return protocol === 'https:' || protocol === 'http:' ? v : null;
  } catch {
    return null;
  }
}

/** The 64 hex digits of a `sha256:<hex>` digest, lower-cased; null for anything else. */
function sha256Of(digest: string | null): string | null {
  const m = digest === null ? null : /^sha256:([0-9a-fA-F]{64})$/.exec(digest);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Updates on macOS: finds the newest release through the GitHub API, downloads its disk image into Downloads after checking
 * the SHA-256 that GitHub publishes for it, then tells the user what to do, opens the image and quits so the user can drag the app into Applications.
 */
export class MacBackend implements UpdateBackend {
  private asset: DmgAsset | null = null;

  constructor(private readonly deps: MacBackendDeps) {}

  private get headers(): Record<string, string> {
    return { 'User-Agent': `lolPing/${this.deps.currentVersion}` };
  }

  async check(): Promise<UpdateInfo | null> {
    const release = await this.fetchRelease();
    // Anything unexpected (a captive portal's page, a rate-limit message, a changed API) is a failed check, never an update.
    if (!isObj(release)) throw new Error('GitHub sent an unexpected answer');
    const { tag_name: tag, html_url: htmlUrl, assets } = release;
    const notesUrl = httpUrl(htmlUrl);
    if (typeof tag !== 'string' || !notesUrl || !Array.isArray(assets)) throw new Error('GitHub sent an unexpected answer');

    // A tag that isn't v + x.y.z (a beta, say) is not a release lolPing offers.
    const version = tag.startsWith('v') ? tag.slice(1) : '';
    if (!isVersion(version) || !isNewer(version, this.deps.currentVersion)) return this.noUpdate();

    const wanted = dmgName(version);
    const found = assets.find((a): a is Record<string, unknown> => isObj(a) && a.name === wanted);
    if (!found) return this.noUpdate(); // the disk image isn't uploaded (yet): nothing to offer a Mac
    const url = httpUrl(found.browser_download_url);
    if (!url) throw new Error('GitHub sent an unexpected answer');
    const size = typeof found.size === 'number' && Number.isFinite(found.size) && found.size > 0 ? Math.floor(found.size) : 0;
    const digest = typeof found.digest === 'string' ? found.digest : null;

    this.asset = { version, name: wanted, url, size, digest };
    return { version, notesUrl };
  }

  async download(info: UpdateInfo, onProgress: (percent: number) => void, signal: AbortSignal): Promise<void> {
    const asset = this.asset;
    if (!asset || asset.version !== info.version) throw new Error(`No download is known for ${info.version}`);
    // No published hash, no download: the file couldn't be verified. (The release page stays open for a manual download.)
    const expected = sha256Of(asset.digest);
    if (!expected) throw new DamagedDownloadError('The release has no SHA-256 digest for the disk image');
    signal.throwIfAborted();

    const dmg = join(this.deps.downloadsDir, asset.name);
    const part = `${dmg}.part`;
    let res: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let file: FileHandle | undefined;

    // Every wait races the abort signal, so quitting never waits for a stalled connection.
    let onAbort = noop;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('The download was cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(noop);
    const unlessAborted = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);

    try {
      await mkdir(this.deps.downloadsDir, { recursive: true });
      res = await unlessAborted(this.deps.fetch(asset.url, { headers: this.headers, signal }));
      if (!res.ok) throw new Error(`The download failed (HTTP ${res.status})`);
      if (!res.body) throw new Error('The download was empty');

      // The published size is the file's real size; Content-Length can describe an encoded body.
      const declared = Number(res.headers.get('content-length'));
      const total = asset.size > 0 ? asset.size : Number.isFinite(declared) && declared > 0 ? declared : 0;
      const hash = createHash('sha256');
      let received = 0;
      let lastPercent = -1;

      file = await open(part, 'w'); // an older, half-written .part is overwritten
      reader = res.body.getReader();
      for (;;) {
        const { done, value } = await unlessAborted(reader.read());
        if (done) break;
        received += value.length;
        // A server sending more than the release says it has cannot be the published file: stop before it fills the disk.
        if (asset.size > 0 && received > asset.size) throw new DamagedDownloadError('The download is larger than the published file');
        hash.update(value);
        await file.writeFile(value);
        signal.throwIfAborted();
        if (total > 0) {
          const percent = Math.min(99, Math.floor((received * 100) / total)); // 100 only once the file is verified and in place
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress(percent);
          }
        }
      }
      await file.close();
      file = undefined;

      if (hash.digest('hex') !== expected) throw new DamagedDownloadError('The download does not match its published SHA-256');
      signal.throwIfAborted(); // an abort that arrives now still never renames
      await rename(part, dmg); // replaces an older disk image of the same name
      onProgress(100);
    } catch (err) {
      // Whatever went wrong: stop reading, close and delete the partial file. A finished file is only ever created by the rename.
      if (reader) await reader.cancel().catch(noop);
      else await res?.body?.cancel().catch(noop);
      await file?.close().catch(noop);
      await rm(part, { force: true }).catch(noop);
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async install(info: UpdateInfo): Promise<void> {
    if (!isVersion(info.version)) throw new Error(`Not a version: ${info.version}`);
    // Explain first, from the front: opening the image brings Finder forward, and a dialog shown after that from the background
    // could stay hidden behind it, with the user left to replace the app that is still running.
    this.deps.focus();
    await this.deps.showDialog(this.deps.dialogText());
    const failure = await this.deps.openPath(join(this.deps.downloadsDir, dmgName(info.version)));
    if (failure) throw new Error(failure);
    this.deps.quit();
  }

  private noUpdate(): null {
    this.asset = null;
    return null;
  }

  /** GET {apiBase}/releases/latest as parsed JSON, within 15 s from the request to the last byte. */
  private async fetchRelease(): Promise<unknown> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('GitHub did not answer within 15 seconds'));
      }, API_TIMEOUT_MS);
    });
    const request = (async (): Promise<unknown> => {
      const url = `${this.deps.apiBase.replace(/\/+$/, '')}/releases/latest`;
      const res = await this.deps.fetch(url, {
        headers: { ...this.headers, Accept: 'application/vnd.github+json' },
        signal: abort.signal,
      });
      if (!res.ok) {
        void res.body?.cancel().catch(noop);
        throw new Error(`GitHub answered ${res.status}`);
      }
      try {
        return JSON.parse(await res.text());
      } catch {
        throw new Error('GitHub sent an unexpected answer');
      }
    })();
    try {
      return await Promise.race([request, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
