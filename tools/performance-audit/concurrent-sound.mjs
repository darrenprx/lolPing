import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'out/concurrent-sound-audit');
const label = process.argv[2];
if (label !== 'before' && label !== 'after') throw new Error('usage: node concurrent-sound.mjs before|after');
await mkdir(output, { recursive: true });
const wav = await readFile(join(root, 'assets/sounds/SRP_12.wav'));
let requests = 0;
const server = createServer((_req, res) => {
  requests++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.end(wav);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/sound.wav`;
await build({
  stdin: { resolveDir: root, loader: 'js', contents: `
import { SoundBank } from './src/renderer/overlay/soundBank.ts';
export async function run(url) {
  const bank = new SoundBank();
  const ctx = bank.ctx;
  const decoded = [];
  const sources = [];
  const gains = [];
  const decode = ctx.decodeAudioData.bind(ctx);
  ctx.decodeAudioData = async bytes => {
    const buffer = await decode(bytes);
    decoded.push(buffer);
    return buffer;
  };
  const createSource = ctx.createBufferSource.bind(ctx);
  ctx.createBufferSource = () => {
    const source = createSource();
    sources.push(source);
    return source;
  };
  const createGain = ctx.createGain.bind(ctx);
  ctx.createGain = () => {
    const gain = createGain();
    gains.push(gain);
    return gain;
  };
  const bytesOf = buffer => buffer.length * buffer.numberOfChannels * 4;
  await Promise.all(Array.from({ length: 8 }, () => bank.playUrl(url, 0.000001)));
  const uniqueBuffers = [...new Set(sources.map(s => s.buffer))];
  const result = {
    requestsToPlay: 8, volume: 0.000001, decodedBuffers: decoded.length,
    decodedPcmBytes: decoded.reduce((n, b) => n + bytesOf(b), 0),
    sourceNodes: sources.length, voices: bank.voices,
    gains: gains.map(g => g.gain.value),
    distinctSourceBuffers: uniqueBuffers.length,
    sourcePcmBytes: uniqueBuffers.reduce((n, b) => n + bytesOf(b), 0),
    sampleRate: ctx.sampleRate,
  };
  await ctx.close();
  return result;
}` },
  bundle: true, format: 'iife', globalName: 'Audit', outfile: join(output, 'renderer.js'),
});
await writeFile(join(output, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(output, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(join(output, 'renderer.js'))}, 'utf8'));
  const result = await win.webContents.executeJavaScript('Audit.run(' + JSON.stringify(${JSON.stringify(url)}) + ')');
  result.environment = { platform: process.platform, electron: process.versions.electron, chrome: process.versions.chrome };
  writeFileSync(${JSON.stringify(join(output, label + '.json'))}, JSON.stringify(result, null, 2));
  win.destroy(); app.quit();
}).catch(err => { console.error(err); app.exit(1); });
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electron = (await import('electron')).default;
try {
  const child = spawn(electron, [join(output, 'main.cjs')], { windowsHide: true, stdio: 'inherit', env });
  const code = await new Promise((done, fail) => { child.once('exit', done); child.once('error', fail); });
  if (code !== 0) throw new Error(`Electron exited with ${code}`);
  const result = JSON.parse(await readFile(join(output, label + '.json'), 'utf8'));
  result.httpRequests = requests;
  await writeFile(join(output, label + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  server.close();
}
