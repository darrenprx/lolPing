// Compares the current ping assets with WAV files from a Git revision through Electron's Web Audio decoder.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function compareAudio(records) {
  const encoded = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
  const results = [];
  for (const sampleRate of [44100, 48000]) {
    const context = new AudioContext({ sampleRate });
    try {
      let decodedBytes = 0;
      for (const record of records) {
        const original = await context.decodeAudioData(encoded(record.wav));
        const current = await context.decodeAudioData(encoded(record.flac));
        if (original.length !== current.length || original.numberOfChannels !== current.numberOfChannels ||
            original.sampleRate !== current.sampleRate) throw new Error(`${record.name}: audio metadata differs`);
        for (let channel = 0; channel < original.numberOfChannels; channel++) {
          const a = original.getChannelData(channel), b = current.getChannelData(channel);
          decodedBytes += a.byteLength;
          for (let frame = 0; frame < a.length; frame++) {
            if (a[frame] !== b[frame]) throw new Error(`${record.name}: PCM differs at channel ${channel}, frame ${frame}`);
          }
        }
      }
      const decodeMs = { wav: [], flac: [] };
      for (let repeat = 0; repeat < 6; repeat++) {
        for (const format of repeat % 2 ? ['flac', 'wav'] : ['wav', 'flac']) {
          const inputs = records.map((record) => encoded(record[format]));
          const start = performance.now();
          for (const input of inputs) await context.decodeAudioData(input);
          decodeMs[format].push(performance.now() - start);
        }
      }
      results.push({ sampleRate, files: records.length, decodedBytes, decodeMs });
    } finally {
      await context.close();
    }
  }
  return results;
}

if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron');
  const temporary = process.argv[2];
  app.setPath('userData', join(temporary, 'data'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await win.loadURL('data:text/html,<!doctype html><title>Audio comparison</title>');
    const records = readFileSync(join(temporary, 'audio.json'), 'utf8');
    const results = await win.webContents.executeJavaScript(`(${compareAudio.toString()})(${records})`);
    console.log(JSON.stringify({ scenario: 'lossless ping audio', electron: process.versions.electron, results }));
    win.destroy();
    app.exit(0);
  }).catch((error) => {
    console.error('FAIL:', error);
    win?.destroy();
    app.exit(1);
  });
} else {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const revision = process.argv[2];
  if (!revision) throw new Error('usage: node tools/performance/audio-assets.mjs <revision-containing-original-WAV-files>');
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const temporary = mkdtempSync(join(tmpdir(), 'lolping-audio-'));
  try {
    mkdirSync(join(temporary, 'data'));
    const { build } = await import('esbuild');
    const catalog = join(temporary, 'pings.cjs');
    await build({ entryPoints: [join(root, 'src/shared/pings.ts')], outfile: catalog, bundle: true, platform: 'node' });
    const { allSoundNames, soundUrl } = createRequire(import.meta.url)(catalog);
    let wavBytes = 0, flacBytes = 0;
    const records = allSoundNames().map((name) => {
      const wav = execFileSync('git', ['show', `${commit}:assets/sounds/${name}.wav`], { cwd: root });
      const flac = readFileSync(join(root, 'assets/sounds', basename(soundUrl(name))));
      wavBytes += wav.length;
      flacBytes += flac.length;
      return { name, wav: wav.toString('base64'), flac: flac.toString('base64') };
    });
    writeFileSync(join(temporary, 'audio.json'), JSON.stringify(records));
    console.log(JSON.stringify({ scenario: 'ping asset bytes', commit, files: records.length, wavBytes, flacBytes }));
    const { default: electron } = await import('electron');
    const result = spawnSync(electron, [fileURLToPath(import.meta.url), temporary], {
      stdio: 'inherit', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
