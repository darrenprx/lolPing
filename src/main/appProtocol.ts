import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { isFile } from './fileState';
import { resolveInside } from './safePath';

/**
 * lolping://app/... serves the production pages, so fetch() works for sounds (file:// would block it), and
 * lolping://emotes/... serves imported emotes from the data folder, in development too.
 */
export const APP_SCHEME = 'lolping';

/** The only names lolping://emotes serves: a hash and `.webp` (the still) or `.anim` (the animation). */
export const EMOTE_URL_RE = /^\/([0-9a-f]{32})\.(webp|anim)$/;

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * The file behind a lolping://emotes path, from the first of `dirs` that has it. `.anim` is the `.anim.gif` or `.anim.webp`
 * on disk, or the still when the animation is missing. Null for any other path.
 */
export function resolveEmoteFile(dirs: readonly string[], urlPath: string): string | null {
  const m = EMOTE_URL_RE.exec(urlPath);
  if (!m) return null;
  const [, hash, kind] = m;
  const names = kind === 'webp' ? [`${hash}.webp`] : [`${hash}.anim.gif`, `${hash}.anim.webp`, `${hash}.webp`];
  for (const name of names) {
    for (const dir of dirs) {
      const file = resolveInside(dir, `/${name}`);
      if (file && isFile(file, false)) return file; // a folder that can't be read serves nothing
    }
  }
  return null;
}

const notFound = (): Response => new Response('Not found', { status: 404 });

/** Imported emotes can be removed and imported again under the same name, so nothing may cache them. */
async function fetchUncached(file: string): Promise<Response> {
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

/** Host `emotes` from `emoteDirs()`; host `app` from `rendererRoot` when set (production); anything else is not found. */
export function serveAppScheme(opts: { rendererRoot: string | null; emoteDirs: () => readonly string[] }): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host === 'emotes') {
      const file = resolveEmoteFile(opts.emoteDirs(), url.pathname);
      return file ? fetchUncached(file) : notFound();
    }
    if (url.host === 'app' && opts.rendererRoot) {
      const file = resolveInside(opts.rendererRoot, url.pathname);
      if (file) return net.fetch(pathToFileURL(file).toString());
    }
    return notFound();
  });
}
