import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';

const temporary = mkdtempSync(join(tmpdir(), 'lolping-performance-'));
try {
  const lifecycle = join(temporary, 'main-lifecycle.cjs');
  await build({ entryPoints: ['tools/performance/main-lifecycle.ts'], outfile: lifecycle, bundle: true, platform: 'node' });
  const main = spawnSync(process.execPath, [lifecycle, resolve('.')], { stdio: 'inherit', timeout: 45_000 });
  if (main.error) throw main.error;
  if (main.status !== 0) throw new Error(`main lifecycle scenario exited with ${main.status}`);
  const data = join(temporary, 'data');
  mkdirSync(data);
  const entry = join(temporary, 'assets.cjs');
  await build({ entryPoints: ['tools/performance/assets.ts'], outfile: entry, bundle: true, platform: 'node', external: ['electron'] });
  const result = spawnSync(electron, [entry, resolve(process.argv[2] ?? '.'), data, ...process.argv.slice(3)], {
    stdio: 'inherit', timeout: 45_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}
