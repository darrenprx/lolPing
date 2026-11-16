import { execFile, type ExecFileException } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinuxSetupResult } from '../shared/ipc';

export const SETUP_SCRIPT = 'linux-input-setup.sh';

/** Runs a program and says how it ended. `code` is the exit code, or a string such as ENOENT when it never started. */
export type RunProgram = (file: string, args: string[]) => Promise<{ code: number | string; stderr: string }>;

export const runProgram: RunProgram = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 120_000, windowsHide: true }, (err: ExecFileException | null, _out, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stderr: String(stderr) });
    });
  });

/** The line the setup card shows for running the script by hand; the path is quoted for a POSIX shell. */
export const manualCommand = (script: string): string => `sudo sh '${script.replace(/'/g, `'\''`)}'`;

/** What the pkexec exit codes mean: 126 the user closed the prompt, 127 authentication failed or was not allowed. */
export function setupResult(r: { code: number | string; stderr: string }): LinuxSetupResult {
  if (r.code === 0) return { ok: true };
  if (r.code === 'ENOENT') return { ok: false, reason: 'missing' };
  if (r.code === 126) return { ok: false, reason: 'cancelled' };
  if (r.code === 127) return { ok: false, reason: 'denied' };
  return { ok: false, reason: 'failed', detail: r.stderr.trim().split('\n').slice(-3).join('\n').slice(0, 300) };
}

/**
 * Runs the setup script as root through pkexec. The script is copied to a private temporary folder first: an
 * AppImage's own files sit on a FUSE mount that root cannot read.
 */
export async function runLinuxSetup(
  source: string, run: RunProgram = runProgram, tmp: string = tmpdir(),
): Promise<LinuxSetupResult> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmp, 'lolping-setup-'));
    const script = join(dir, SETUP_SCRIPT);
    await copyFile(source, script);
    await chmod(script, 0o755);
    return setupResult(await run('pkexec', [script]));
  } catch (err) {
    return { ok: false, reason: 'failed', detail: String(err).slice(0, 300) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Puts a copy of the script where the by-hand command can point at it. */
export async function stageManualScript(source: string, to: string): Promise<void> {
  await copyFile(source, to);
  await chmod(to, 0o644);
}
