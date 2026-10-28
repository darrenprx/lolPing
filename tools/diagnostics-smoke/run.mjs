// Exercise real Electron failure events in hidden native windows without desktop automation.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.argv[2] ?? join(root, '..', 'acceptance', 'startup-diagnostics'));
const bundle = join(root, 'out', 'main', 'diagnostics-smoke.cjs');
await mkdir(output, { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, 'smoke.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
const env = { ...process.env, LOLPING_HIDDEN_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
try {
  for (const mode of ['recovery', 'fatal']) {
    const result = spawnSync(join(root, 'node_modules/electron/dist/electron.exe'), [bundle, output, mode],
      { cwd: root, env, windowsHide: true, timeout: 30_000, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, mode === 'fatal' ? 1 : 0, result.stderr);
    const events = (await readFile(join(output, `${mode}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    const expected = mode === 'fatal' ? ['startup-failed', 'forced-exit'] :
      ['window-created', 'preload-failed', 'page-failed', 'startup-complete', 'renderer-gone', 'page-loaded',
        'input-helper-error', 'input-helper-status-test', 'before-quit', 'process-exit'];
    for (const event of expected) {
      assert(events.some((entry) => entry.event === event), `${mode}: missing ${event}`);
      checks.push(`${mode}: ${event}`);
    }
    if (mode === 'recovery') {
      assert(events.filter((entry) => entry.event === 'page-loaded').length >= 2, 'renderer reload recovers');
      checks.push('renderer reload recovers');
    }
  }
  const early = join(output, 'early-main-missing');
  await mkdir(early, { recursive: true });
  await writeFile(join(early, 'bootstrap.cjs'), await readFile(join(root, 'out/main/bootstrap.cjs')));
  await writeFile(join(early, 'startupDiagnostics.js'),
    `module.exports = require(${JSON.stringify(join(root, 'out/main/startupDiagnostics.js'))});`);
  const result = spawnSync(join(root, 'node_modules/electron/dist/electron.exe'), [join(early, 'bootstrap.cjs')],
    { cwd: early, env: { ...env, LOCALAPPDATA: early }, windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stderr);
  const earlyLogs = join(early, 'lolPing/logs');
  const log = (await readdir(earlyLogs)).find((name) => name.endsWith('.jsonl'));
  assert(log, 'early bootstrap log exists');
  const events = (await readFile(join(earlyLogs, log), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const event of ['bootstrap', 'startup-failed', 'forced-exit']) {
    assert(events.some((entry) => entry.event === event), `before ready: missing ${event}`);
    checks.push(`before ready: ${event}`);
  }
  assert(events.some((entry) => String(entry.message).includes('index.js')), 'missing main module is identified');
  checks.push('before ready: missing main module identified');
  await writeFile(join(output, 'native-diagnostics-summary.json'), JSON.stringify({ passed: checks.length, checks }, null, 2));
  console.log(`${checks.length} native diagnostics checks passed`);
} finally { await rm(bundle, { force: true }); }
