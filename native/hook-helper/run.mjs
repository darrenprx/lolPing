// `node native/hook-helper/run.mjs build|test`: builds the hook and context helpers (and runs their C++ tests) on Windows, macOS or Linux.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: here });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const action = process.argv[2];
if (action !== 'build' && action !== 'test') {
  console.error('usage: node native/hook-helper/run.mjs build|test');
  process.exit(2);
}
// The explicit .\ matters: cmd may be set to not search the current directory for commands.
if (win) run('cmd.exe', ['/d', '/c', '.\\build.cmd']);
else run('sh', ['build.sh']);
if (action === 'test') {
  for (const name of ['helper_tests', 'context_tests', 'output-scenario', 'decision-scenario']) run(join(here, 'build', win ? `${name}.exe` : name), []);
}
if (action === 'test' && process.platform === 'darwin') run(join(here, 'build', 'hooks_mac_tests'), []);
