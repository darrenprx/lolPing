// Renders the real app pages in hidden native windows. No desktop capture, input injection or public network.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.argv[2] ?? join(root, '..', 'acceptance', 'room-shots'));
const bundle = join(root, 'out', 'main', 'room-shot-smoke.cjs');
await mkdir(output, { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, 'smoke.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
try {
  const result = spawnSync(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [bundle, output, root],
    { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 90_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(bundle, { force: true });
}
