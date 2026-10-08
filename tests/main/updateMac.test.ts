import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MacBackend, RELEASES_API, type MacBackendDeps } from '../../src/main/updateMac';
import { DamagedDownloadError, type UpdateInfo } from '../../src/main/updater';
import fixture from './fixtures/github-release-latest.json';

const PAYLOAD = Buffer.alloc(65536, 7);
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');
const LATEST_URL = `${RELEASES_API}/releases/latest`;
const DMG_NAME = 'lolPing-0.5.1-arm64.dmg';
const DMG_URL = `https://github.com/darrenprx/lolPing/releases/download/v0.5.1/${DMG_NAME}`;
const NOTES_URL = 'https://github.com/darrenprx/lolPing/releases/tag/v0.5.1';

type Release = typeof fixture;
const release = (edit: (r: Release) => void = () => undefined): Release => {
  const r = structuredClone(fixture);
  edit(r);
  return r;
};
const dmgAsset = (r: Release) => r.assets.find((a) => a.name === DMG_NAME)!;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/** A body that arrives in chunks. */
function streamOf(buf: Uint8Array, chunk = 8192): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= buf.length) {
        c.close();
        return;
      }
      c.enqueue(buf.subarray(off, off + chunk));
      off += chunk;
    },
  });
}

const dmgResponse = (buf: Uint8Array = PAYLOAD, headers: Record<string, string> = {}): Response =>
  new Response(streamOf(buf), { status: 200, headers });

let dir: string;
let calls: { url: string; init?: RequestInit }[];

/** Serves the release JSON at the API and `dmg()` at the asset URL. */
function serve(rel: unknown = release(), dmg: () => Response | Promise<Response> = () => dmgResponse()): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === LATEST_URL) return rel instanceof Response ? rel : json(rel);
    if (url === DMG_URL) return dmg();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function make(over: Partial<MacBackendDeps> = {}): { backend: MacBackend; deps: MacBackendDeps } {
  const deps: MacBackendDeps = {
    apiBase: RELEASES_API,
    currentVersion: '0.5.0',
    fetch: serve(),
    downloadsDir: dir,
    focus: vi.fn(),
    showDialog: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    dialogText: () => 'Drag lolPing into Applications.',
    quit: vi.fn(),
    ...over,
  };
  return { backend: new MacBackend(deps), deps };
}

/** A backend that has already found 0.5.1. */
async function found(over: Partial<MacBackendDeps> = {}): Promise<{ backend: MacBackend; deps: MacBackendDeps; info: UpdateInfo }> {
  const made = make(over);
  const info = await made.backend.check();
  if (!info) throw new Error('the fixture should hold an update');
  return { ...made, info };
}

const files = (): string[] => fs.readdirSync(dir).sort();
const noAbort = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolping-mac-'));
  calls = [];
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MacBackend.check', () => {
  it('finds a newer release', async () => {
    const { backend } = make();
    await expect(backend.check()).resolves.toEqual({ version: '0.5.1', notesUrl: NOTES_URL });
  });

  it('asks the releases API with the User-Agent and Accept headers', async () => {
    const { backend } = make();
    await backend.check();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(LATEST_URL);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('user-agent')).toBe('lolPing/0.5.0');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the API base it was given, without doubling a trailing slash', async () => {
    const seen: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return json(release());
    }) as typeof fetch;
    const { backend } = make({ apiBase: 'http://127.0.0.1:8123/', fetch: fetchFn });
    await backend.check();
    expect(seen).toEqual(['http://127.0.0.1:8123/releases/latest']);
  });

  it('says there is no update when the release is the running version or older', async () => {
    expect(await make({ currentVersion: '0.5.1' }).backend.check()).toBeNull();
    expect(await make({ currentVersion: '0.6.0' }).backend.check()).toBeNull();
  });

  it('ignores a tag that is not v + x.y.z', async () => {
    for (const tag of ['v0.5.2-beta', '0.5.2', 'v0.5', 'release-1']) {
      const { backend } = make({ fetch: serve(release((r) => (r.tag_name = tag))) });
      expect(await backend.check(), tag).toBeNull();
    }
  });

  it('says there is no update when the release has no disk image for this version', async () => {
    const without = release((r) => (r.assets = r.assets.filter((a) => !a.name.endsWith('.dmg'))));
    expect(await make({ fetch: serve(without) }).backend.check()).toBeNull();
    const wrongVersion = release((r) => (dmgAsset(r).name = 'lolPing-0.5.0-arm64.dmg'));
    expect(await make({ fetch: serve(wrongVersion) }).backend.check()).toBeNull();
    const intel = release((r) => (dmgAsset(r).name = 'lolPing-0.5.1-x64.dmg'));
    expect(await make({ fetch: serve(intel) }).backend.check()).toBeNull();
  });

  it('treats non-JSON and missing fields as a failed check', async () => {
    const bad: [string, Response][] = [
      ['an HTML page', new Response('<html><body>Sign in to the Wi-Fi</body></html>', { status: 200 })],
      ['an empty body', new Response('', { status: 200 })],
      ['null', json(null)],
      ['an array', json([release()])],
      ['{}', json({})],
      ['a numeric tag_name', json(release((r) => ((r as { tag_name: unknown }).tag_name = 5)))],
      ['no tag_name', json(release((r) => delete (r as { tag_name?: unknown }).tag_name))],
      ['no html_url', json(release((r) => delete (r as { html_url?: unknown }).html_url))],
      ['a javascript: html_url', json(release((r) => (r.html_url = 'javascript:alert(1)')))],
      ['assets that is not a list', json(release((r) => ((r as { assets: unknown }).assets = 'none')))],
      ['no assets', json(release((r) => delete (r as { assets?: unknown }).assets))],
      ['a disk image without a download URL', json(release((r) => delete (dmgAsset(r) as { browser_download_url?: unknown }).browser_download_url))],
      ['a disk image with a file: download URL', json(release((r) => (dmgAsset(r).browser_download_url = 'file:///etc/passwd')))],
    ];
    for (const [label, body] of bad) {
      const { backend } = make({ fetch: serve(body) });
      await expect(backend.check(), label).rejects.toThrow();
    }
  });

  it('a rate limit or error status is a failed check that says the status', async () => {
    for (const status of [403, 429, 500]) {
      const { backend } = make({ fetch: serve(new Response('{"message":"API rate limit exceeded"}', { status })) });
      await expect(backend.check()).rejects.toThrow(String(status));
    }
  });

  it('a network failure is a failed check', async () => {
    const { backend } = make({ fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
    await expect(backend.check()).rejects.toThrow('fetch failed');
  });

  it('times out after 15 s', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const hang = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => undefined); // never answers, and ignores the signal
    }) as typeof fetch;
    const { backend } = make({ fetch: hang });
    const outcome = expect(backend.check()).rejects.toThrow(/15 seconds/);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(signal?.aborted).toBe(true);
  });

  it('times out while the body stalls too', async () => {
    vi.useFakeTimers();
    const stalled = new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 });
    const { backend } = make({ fetch: serve(stalled) });
    const outcome = expect(backend.check()).rejects.toThrow(/15 seconds/);
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
  });

  it('a quick answer leaves no timer behind', async () => {
    vi.useFakeTimers();
    const { backend } = make();
    await backend.check();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('MacBackend.download', () => {
  it('downloads and verifies', async () => {
    const { backend, info } = await found();
    const progress: number[] = [];
    await backend.download(info, (p) => progress.push(p), noAbort());
    expect(progress.at(-1)).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.filter((p) => p === 100)).toHaveLength(1);
    expect(progress.every((p) => Number.isInteger(p) && p >= 0 && p <= 100)).toBe(true);
    expect(files()).toEqual([DMG_NAME]);
    expect(fs.readFileSync(path.join(dir, DMG_NAME)).equals(PAYLOAD)).toBe(true);
  });

  it('asks for the asset URL with the User-Agent and the abort signal', async () => {
    const { backend, info } = await found();
    const ac = new AbortController();
    await backend.download(info, () => undefined, ac.signal);
    const call = calls.find((c) => c.url === DMG_URL)!;
    expect(new Headers(call.init?.headers).get('user-agent')).toBe('lolPing/0.5.0');
    expect(call.init?.signal).toBe(ac.signal);
  });

  it('reports progress from Content-Length when the release gives no size', async () => {
    const rel = release((r) => (dmgAsset(r).size = 0));
    const { backend, info } = await found({ fetch: serve(rel, () => dmgResponse(PAYLOAD, { 'content-length': String(PAYLOAD.length) })) });
    const progress: number[] = [];
    await backend.download(info, (p) => progress.push(p), noAbort());
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(100);
    expect(progress[0]).toBe(12); // the first 8 KB of 64 KB
  });

  it('reports no progress before the end when it cannot know the size', async () => {
    const rel = release((r) => (dmgAsset(r).size = 0));
    const { backend, info } = await found({ fetch: serve(rel) });
    const progress: number[] = [];
    await backend.download(info, (p) => progress.push(p), noAbort());
    expect(progress).toEqual([100]);
    expect(fs.readFileSync(path.join(dir, DMG_NAME)).equals(PAYLOAD)).toBe(true);
  });

  it('refuses a missing digest and writes nothing', async () => {
    const rel = release((r) => delete (dmgAsset(r) as { digest?: unknown }).digest);
    const { backend, info } = await found({ fetch: serve(rel) });
    await expect(backend.download(info, () => undefined, noAbort())).rejects.toBeInstanceOf(DamagedDownloadError);
    expect(files()).toEqual([]);
    expect(calls.some((c) => c.url === DMG_URL)).toBe(false);
  });

  it('refuses a digest that is not sha256 plus 64 hex digits', async () => {
    for (const digest of [`md5:${PAYLOAD_SHA.slice(0, 32)}`, `sha256:${PAYLOAD_SHA.slice(1)}`, PAYLOAD_SHA, `sha256:${'g'.repeat(64)}`, '', null, 5]) {
      const rel = release((r) => ((dmgAsset(r) as { digest: unknown }).digest = digest));
      const { backend, info } = await found({ fetch: serve(rel) });
      await expect(backend.download(info, () => undefined, noAbort()), String(digest)).rejects.toBeInstanceOf(DamagedDownloadError);
      expect(files()).toEqual([]);
    }
  });

  it('accepts an upper-case digest', async () => {
    const rel = release((r) => (dmgAsset(r).digest = `sha256:${PAYLOAD_SHA.toUpperCase()}`));
    const { backend, info } = await found({ fetch: serve(rel) });
    await backend.download(info, () => undefined, noAbort());
    expect(files()).toEqual([DMG_NAME]);
  });

  it('refuses a wrong digest, deleting the .part', async () => {
    const other = Buffer.alloc(65536, 8); // the published size, other bytes
    const { backend, info } = await found({ fetch: serve(release(), () => dmgResponse(other)) });
    await expect(backend.download(info, () => undefined, noAbort())).rejects.toBeInstanceOf(DamagedDownloadError);
    expect(files()).toEqual([]);
  });

  it('refuses a download that stops short', async () => {
    const { backend, info } = await found({ fetch: serve(release(), () => dmgResponse(PAYLOAD.subarray(0, 40000))) });
    await expect(backend.download(info, () => undefined, noAbort())).rejects.toBeInstanceOf(DamagedDownloadError);
    expect(files()).toEqual([]);
  });

  it('stops reading a download that outgrows the published size', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        if (++pulled > 100) c.close(); // a bound for the test; the backend must give up long before it
        else c.enqueue(Buffer.alloc(8192, 7));
      },
    });
    const { backend, info } = await found({ fetch: serve(release(), () => new Response(endless, { status: 200 })) });
    await expect(backend.download(info, () => undefined, noAbort())).rejects.toBeInstanceOf(DamagedDownloadError);
    expect(pulled).toBeLessThan(15); // the 64 KB file is 8 chunks
    expect(files()).toEqual([]);
  });

  it('replaces an earlier file and a stale .part', async () => {
    fs.writeFileSync(path.join(dir, DMG_NAME), 'half-written junk from an earlier try');
    fs.writeFileSync(path.join(dir, `${DMG_NAME}.part`), Buffer.alloc(200_000, 1)); // longer than the real file
    const { backend, info } = await found();
    await backend.download(info, () => undefined, noAbort());
    expect(files()).toEqual([DMG_NAME]);
    expect(fs.readFileSync(path.join(dir, DMG_NAME)).equals(PAYLOAD)).toBe(true);
  });

  it('keeps an earlier file when the new download fails', async () => {
    fs.writeFileSync(path.join(dir, DMG_NAME), 'the old image');
    const other = Buffer.alloc(65536, 8);
    const { backend, info } = await found({ fetch: serve(release(), () => dmgResponse(other)) });
    await expect(backend.download(info, () => undefined, noAbort())).rejects.toBeInstanceOf(DamagedDownloadError);
    expect(files()).toEqual([DMG_NAME]);
    expect(fs.readFileSync(path.join(dir, DMG_NAME), 'utf8')).toBe('the old image');
  });

  it('an aborted download never renames', async () => {
    const ac = new AbortController();
    const stalling = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(PAYLOAD.subarray(0, 16384)); // then nothing more arrives
      },
    });
    const { backend, info } = await found({ fetch: serve(release(), () => new Response(stalling, { status: 200 })) });
    const got = vi.fn();
    const outcome = backend.download(info, got, ac.signal);
    const settled = expect(outcome).rejects.toThrow();
    await vi.waitFor(() => expect(got).toHaveBeenCalled()); // bytes are on disk
    ac.abort();
    await settled;
    expect(files()).toEqual([]);
    expect(got).not.toHaveBeenCalledWith(100);
  });

  it('an abort that arrives before the answer cancels the request', async () => {
    const ac = new AbortController();
    const hang = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input) === LATEST_URL) return json(release());
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as typeof fetch;
    const { backend, info } = await found({ fetch: hang });
    const outcome = backend.download(info, () => undefined, ac.signal);
    const settled = expect(outcome).rejects.toThrow();
    ac.abort();
    await settled;
    expect(files()).toEqual([]);
  });

  it('an already aborted signal downloads nothing', async () => {
    const { backend, info } = await found();
    const ac = new AbortController();
    ac.abort();
    await expect(backend.download(info, () => undefined, ac.signal)).rejects.toThrow();
    expect(calls.some((c) => c.url === DMG_URL)).toBe(false);
    expect(files()).toEqual([]);
  });

  it('an HTTP error is a plain failure, not a damaged file', async () => {
    const { backend, info } = await found({ fetch: serve(release(), () => new Response('gone', { status: 404 })) });
    const err = await backend.download(info, () => undefined, noAbort()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DamagedDownloadError);
    expect((err as Error).message).toContain('404');
    expect(files()).toEqual([]);
  });

  it('a connection that breaks mid-download is a plain failure and leaves no .part', async () => {
    let sent = false;
    const breaking = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(PAYLOAD.subarray(0, 8192));
        } else {
          c.error(new Error('connection reset'));
        }
      },
    });
    const { backend, info } = await found({ fetch: serve(release(), () => new Response(breaking, { status: 200 })) });
    const err = await backend.download(info, () => undefined, noAbort()).catch((e: unknown) => e);
    expect((err as Error).message).toContain('connection reset');
    expect(err).not.toBeInstanceOf(DamagedDownloadError);
    expect(files()).toEqual([]);
  });

  it('creates the Downloads folder when it is missing', async () => {
    const sub = path.join(dir, 'Downloads');
    const { backend, info } = await found({ downloadsDir: sub });
    await backend.download(info, () => undefined, noAbort());
    expect(fs.readFileSync(path.join(sub, DMG_NAME)).equals(PAYLOAD)).toBe(true);
  });

  it('a Downloads folder that cannot be written is a plain failure', async () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const { backend, info } = await found({ downloadsDir: path.join(blocker, 'Downloads') });
    await expect(backend.download(info, () => undefined, noAbort())).rejects.toThrow();
  });

  it('an unwritable Downloads folder fails with a plain error, not a damaged file, and leaves no files', async () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const { backend, info } = await found({ downloadsDir: path.join(blocker, 'Downloads') });
    const err = await backend.download(info, () => undefined, noAbort()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DamagedDownloadError);
    expect(files()).toEqual(['file']); // nothing but the file that was already there
    expect(fs.readFileSync(blocker, 'utf8')).toBe('x');
  });

  it('a .part that cannot be opened fails with a plain error, stops the download and leaves no disk image', async () => {
    fs.mkdirSync(path.join(dir, `${DMG_NAME}.part`)); // a folder where the file has to go
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(8192));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { backend, info } = await found({ fetch: serve(release(), () => new Response(body, { status: 200 })) });
    const err = await backend.download(info, () => undefined, noAbort()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DamagedDownloadError);
    expect(cancelled).toBe(true);
    expect(files().filter((f) => f.endsWith('.dmg'))).toEqual([]);
  });

  it('only downloads what the last check found', async () => {
    const { backend } = make();
    await expect(backend.download({ version: '0.5.1', notesUrl: NOTES_URL }, () => undefined, noAbort())).rejects.toThrow();
    const found1 = await backend.check();
    await expect(backend.download({ version: '9.9.9', notesUrl: NOTES_URL }, () => undefined, noAbort())).rejects.toThrow();
    expect(found1).not.toBeNull();
    expect(files()).toEqual([]);
  });

  it('forgets the update when a later check finds none', async () => {
    let latest = release();
    const fetchFn = (async (input: RequestInfo | URL) => (String(input) === LATEST_URL ? json(latest) : dmgResponse())) as typeof fetch;
    const { backend, info } = await found({ fetch: fetchFn });
    latest = release((r) => (r.tag_name = 'v0.5.0')); // the release was pulled
    expect(await backend.check()).toBeNull();
    await expect(backend.download(info, () => undefined, noAbort())).rejects.toThrow();
    expect(files()).toEqual([]);
  });
});

describe('MacBackend.install', () => {
  it('comes to the front, explains, opens the image and quits, in that order', async () => {
    const order: string[] = [];
    const { backend, deps } = await found({
      focus: vi.fn(() => {
        order.push('focus');
      }),
      showDialog: vi.fn(async (m: string) => {
        order.push(`dialog ${m}`);
      }),
      openPath: vi.fn(async (p: string) => {
        order.push(`open ${path.basename(p)}`);
        return '';
      }),
      quit: vi.fn(() => {
        order.push('quit');
      }),
    });
    await backend.install({ version: '0.5.1', notesUrl: NOTES_URL });
    expect(order).toEqual(['focus', 'dialog Drag lolPing into Applications.', `open ${DMG_NAME}`, 'quit']);
    expect(deps.openPath).toHaveBeenCalledWith(path.join(dir, DMG_NAME));
    expect(deps.showDialog).toHaveBeenCalledWith(deps.dialogText());
  });

  it('does not open the image until the dialog is dismissed', async () => {
    let dismiss!: () => void;
    const { backend, deps } = await found({ showDialog: vi.fn(() => new Promise<void>((resolve) => (dismiss = resolve))) });
    const p = backend.install({ version: '0.5.1', notesUrl: NOTES_URL });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.focus).toHaveBeenCalledTimes(1);
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
    dismiss();
    await p;
    expect(deps.openPath).toHaveBeenCalledTimes(1);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it('a failure to open the image rejects and does not quit', async () => {
    const { backend, deps } = await found({ openPath: vi.fn(async () => 'The file does not exist') });
    await expect(backend.install({ version: '0.5.1', notesUrl: NOTES_URL })).rejects.toThrow('The file does not exist');
    expect(deps.showDialog).toHaveBeenCalledTimes(1); // the user was told first; the failure then shows on the update card
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it('refuses a version that is not x.y.z', async () => {
    const { backend, deps } = await found();
    await expect(backend.install({ version: '../../evil', notesUrl: NOTES_URL })).rejects.toThrow();
    expect(deps.focus).not.toHaveBeenCalled();
    expect(deps.showDialog).not.toHaveBeenCalled();
    expect(deps.openPath).not.toHaveBeenCalled();
  });
});
