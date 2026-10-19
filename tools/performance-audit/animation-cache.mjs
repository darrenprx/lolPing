import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'out/animation-cache-audit');
const label = process.argv[2];
if (label !== 'before' && label !== 'after') throw new Error('usage: node animation-cache.mjs before|after [baseline-ref]');
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', (process.argv[3] ?? 'main') + '^{commit}'], {
  cwd: root, encoding: 'utf8',
}).trim();
await mkdir(output, { recursive: true });
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/audit') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><html><body></body></html>');
  }
  const file = resolve(root, 'assets', '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(join(root, 'assets') + sep)) return res.writeHead(403).end();
  try {
    const bytes = await readFile(file);
    requests.push({ file: req.url, bytes: bytes.length });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'no-store');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
await build({
  plugins: label === 'before' ? [{ name: 'baseline-emote-stage', setup(builder) {
    builder.onLoad({ filter: /[\\/]emoteStage\.ts$/ }, () => ({
      contents: execFileSync('git', ['show', baselineCommit + ':src/renderer/overlay/emoteStage.ts'], { cwd: root, encoding: 'utf8' }),
      loader: 'ts', resolveDir: join(root, 'src/renderer/overlay'),
    }));
  } }] : [],
  stdin: { resolveDir: root, loader: 'js', contents: `
import { EmoteStage } from './src/renderer/overlay/emoteStage.ts';
import { EMOTE_CATALOG, DEFAULT_EMOTE_WHEEL, DEFAULT_CLICK_EMOTE } from './src/shared/emoteCatalog.ts';
export async function run(base) {
  const layer = document.createElement('div'); document.body.append(layer);
  const fetched = [];
  const sizes = new Map();
  const fetchBlob = async url => {
    fetched.push(url);
    const res = await fetch(base + url.slice(2));
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob(); sizes.set(url, blob.size); return blob;
  };
  const stage = new EmoteStage(layer, fetchBlob);
  const cacheStats = async () => {
    const blobs = stage.blobs instanceof Map ? await Promise.all([...stage.blobs.values()]) : [...stage.blobs.ready.values()];
    return { entries: blobs.length, bytes: blobs.reduce((n, b) => n + b.size, 0) };
  };
  const paintHash = image => {
    const canvas = document.createElement('canvas'); canvas.width = image.displayWidth ?? image.naturalWidth;
    canvas.height = image.displayHeight ?? image.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
    return hash >>> 0;
  };
  const spawn = (slug, owner = 'audit', target = stage, fingerprint = false) => {
    const started = performance.now();
    target.spawn(owner, { kind: 'bundled', slug }, 100, 100, { sizePx: 110 });
    const img = layer.lastElementChild.querySelector('img.sheet');
    return new Promise((resolve, reject) => {
      img.addEventListener('load', () => resolve({ url: img.src, ms: performance.now() - started, hash: fingerprint ? paintHash(img) : null, img }), { once: true });
      img.addEventListener('error', () => reject(new Error('Image decode failed: ' + slug)), { once: true });
    });
  };
  const cold = [];
  for (const entry of EMOTE_CATALOG) {
    const image = await spawn(entry.slug);
    cold.push({ slug: entry.slug, ms: image.ms });
    stage.clear('audit');
  }
  const retained = await cacheStats();
  const first = await spawn(EMOTE_CATALOG[0].slug, 'pinned');
  const pinnedUrl = first.url;
  for (const entry of EMOTE_CATALOG.slice(-20)) { await spawn(entry.slug); stage.clear('audit'); }
  const activeSurvivedPressure = first.img.isConnected && first.img.src === pinnedUrl && first.img.complete && first.img.naturalWidth > 0;
  const activeUrlReadable = (await fetch(pinnedUrl)).ok;
  stage.clear('pinned');
  let revokedAfterClear = false;
  try { await fetch(pinnedUrl); } catch { revokedAfterClear = true; }
  const wheel = [...DEFAULT_EMOTE_WHEEL, DEFAULT_CLICK_EMOTE];
  for (const slug of wheel) { await spawn(slug); stage.clear('audit'); }
  const beforeHot = fetched.length;
  const hot = [];
  for (let pass = 0; pass < 10; pass++) {
    for (const slug of wheel) {
      const image = await spawn(slug); hot.push(image.ms); stage.clear('audit');
    }
  }
  const hotFetches = fetched.length - beforeHot;
  const largestWheel = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 9)
    .map(([url]) => url.split('/').pop().replace('.webp', ''));
  for (const slug of largestWheel) { await spawn(slug); stage.clear('audit'); }
  const beforeLargestHot = fetched.length;
  for (let pass = 0; pass < 3; pass++) {
    for (const slug of largestWheel) { await spawn(slug); stage.clear('audit'); }
  }
  const largestWheelHotFetches = fetched.length - beforeLargestHot;
  const replayBefore = await spawn(EMOTE_CATALOG[0].slug, 'audit', stage, true); stage.clear('audit');
  for (const entry of EMOTE_CATALOG.slice(1)) { await spawn(entry.slug); stage.clear('audit'); }
  const fetchesBeforeReplay = fetched.length;
  const replay = await spawn(EMOTE_CATALOG[0].slug, 'audit', stage, true); stage.clear('audit');
  const replayReloaded = fetched.length > fetchesBeforeReplay;
  const referenceResponse = await fetch(base + '/emotes/' + EMOTE_CATALOG[0].slug + '.webp');
  const decoder = new ImageDecoder({ data: await referenceResponse.arrayBuffer(), type: 'image/webp' });
  const frame = (await decoder.decode({ frameIndex: 0 })).image;
  const referenceHash = paintHash(frame); frame.close(); decoder.close();
  const beforeConcurrent = fetched.length;
  const concurrentStage = new EmoteStage(layer, fetchBlob);
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => spawn(EMOTE_CATALOG[1].slug, 'peer-' + i, concurrentStage)));
  const concurrentFetches = fetched.length - beforeConcurrent;
  const uniqueUrls = new Set(concurrent.map(image => image.url)).size;
  for (let i = 0; i < 8; i++) concurrentStage.clear('peer-' + i);
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
  const result = {
    retainedAfterCatalogue: retained, finalCache: await cacheStats(), catalogueSize: EMOTE_CATALOG.length,
    hotWheelFetches: hotFetches, hotWheelSamples: hot.length, largestWheelHotFetches,
    hotMedianMs: percentile(hot, .5), hotP95Ms: percentile(hot, .95),
    coldMedianMs: percentile(cold.map(x => x.ms), .5), coldP95Ms: percentile(cold.map(x => x.ms), .95),
    reloadAfterEvictionMs: replay.ms, replayReloaded,
    activeSurvivedPressure, activeUrlReadable, revokedAfterClear,
    replayUsesNewUrl: replay.url !== replayBefore.url,
    firstFrameMatchesReference: replay.hash === referenceHash && replayBefore.hash === referenceHash,
    firstFrameHashes: { before: replayBefore.hash, afterEviction: replay.hash, reference: referenceHash },
    concurrentFetches, concurrentUniqueUrls: uniqueUrls, remainingNodes: layer.childElementCount,
    fetches: fetched.length,
  };
  return result;
}` },
  bundle: true, format: 'iife', globalName: 'Audit', outfile: join(output, 'renderer.js'),
});
await writeFile(join(output, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(output, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(${JSON.stringify(base + '/audit')});
  await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(join(output, 'renderer.js'))}, 'utf8'));
  const result = await win.webContents.executeJavaScript('Audit.run(' + JSON.stringify(${JSON.stringify(base)}) + ')');
  result.environment = { platform: process.platform, electron: process.versions.electron, chrome: process.versions.chrome };
  writeFileSync(${JSON.stringify(join(output, label + '.json'))}, JSON.stringify(result, null, 2));
  win.destroy(); app.quit();
}).catch(err => { console.error(err); app.exit(1); });
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn((await import('electron')).default, [join(output, 'main.cjs')], { windowsHide: true, stdio: 'inherit', env });
  const code = await new Promise((done, fail) => { child.once('exit', done); child.once('error', fail); });
  if (code !== 0) throw new Error('Electron audit failed: ' + code);
  const result = JSON.parse(await readFile(join(output, label + '.json'), 'utf8'));
  result.httpRequests = requests.length;
  result.source = label === 'before' ? baselineCommit : 'working tree';
  if (!result.activeSurvivedPressure || !result.activeUrlReadable || !result.revokedAfterClear
    || !result.replayUsesNewUrl || !result.firstFrameMatchesReference || result.remainingNodes !== 0
    || result.concurrentFetches !== 1 || result.concurrentUniqueUrls !== 8
    || result.hotWheelFetches !== 0 || result.largestWheelHotFetches !== 0) {
    throw new Error('Animation behavior checks failed: ' + JSON.stringify(result));
  }
  if (label === 'after' && result.retainedAfterCatalogue.bytes > 16 * 1024 * 1024) {
    throw new Error('Animation cache exceeded its byte budget');
  }
  await writeFile(join(output, label + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { server.close(); }
