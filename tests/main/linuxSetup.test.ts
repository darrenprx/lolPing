import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manualCommand, runLinuxSetup, setupResult, stageManualScript } from '../../src/main/linuxSetup';

describe('setupResult', () => {
  it('maps what pkexec and the system say to a reason', () => {
    expect(setupResult({ code: 0, stderr: '' })).toEqual({ ok: true });
    expect(setupResult({ code: 'ENOENT', stderr: '' })).toEqual({ ok: false, reason: 'missing' });
    expect(setupResult({ code: 126, stderr: '' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(setupResult({ code: 127, stderr: '' })).toEqual({ ok: false, reason: 'denied' });
    expect(setupResult({ code: 1, stderr: 'a\nb\nc\nd\n' })).toEqual({ ok: false, reason: 'failed', detail: 'b\nc\nd' });
  });
});

describe('manualCommand', () => {
  it('quotes the path for a POSIX shell', () => {
    expect(manualCommand('/home/me/.config/lolPing/linux-input-setup.sh')).toBe("sudo sh '/home/me/.config/lolPing/linux-input-setup.sh'");
    expect(manualCommand("/home/o'neil/x.sh")).toBe("sudo sh '/home/o'\''neil/x.sh'");
  });
});

describe('runLinuxSetup', () => {
  let dir: string;
  let source: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lolping-test-'));
    source = join(dir, 'src.sh');
    await writeFile(source, '#!/bin/sh\necho hi\n');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('runs a copy of the script through pkexec and removes the copy', async () => {
    let ran: { file: string; args: string[]; text: string } | null = null;
    const result = await runLinuxSetup(source, async (file, args) => {
      ran = { file, args, text: await readFile(args[0], 'utf8') };
      return { code: 0, stderr: '' };
    }, dir);
    expect(result).toEqual({ ok: true });
    expect(ran).toMatchObject({ file: 'pkexec', text: '#!/bin/sh\necho hi\n' });
    expect(ran!.args[0]).not.toBe(source);
    expect((await readdir(dir)).filter((n) => n.startsWith('lolping-setup-'))).toEqual([]);
  });

  it('reports a failed run and still removes the copy', async () => {
    const result = await runLinuxSetup(source, async () => ({ code: 126, stderr: '' }), dir);
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect((await readdir(dir)).filter((n) => n.startsWith('lolping-setup-'))).toEqual([]);
  });

  it('reports a script that cannot be copied', async () => {
    const result = await runLinuxSetup(join(dir, 'nope.sh'), async () => ({ code: 0, stderr: '' }), dir);
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('stageManualScript', () => {
  it('copies the script to the given place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lolping-test-'));
    try {
      await writeFile(join(dir, 'a.sh'), 'x');
      await stageManualScript(join(dir, 'a.sh'), join(dir, 'b.sh'));
      expect(await readFile(join(dir, 'b.sh'), 'utf8')).toBe('x');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
