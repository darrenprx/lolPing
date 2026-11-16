import { spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, AgentStartError, isExecutable, killProcessTree } from '../../../../src/main/teammate/agents/runner';
import { platformOf } from '../../../../src/shared/platform';
import { AGENT_PRESET_IDS, AGENT_PRESETS, agentPrompt, type AgentRunSpec } from '../../../../src/shared/teammate/agents';
import type { AgentProfile } from '../../../../src/shared/teammate/settings';

const FAKE = path.resolve('tests/main/fixtures/fakeAgent.mjs');
const platform = platformOf(process.platform);
const win = process.platform === 'win32';
const SLOW = 20_000;
// taskkill alone can take 10 s on a busy Windows machine (it lists every process first).
const KILL_SLOW = 60_000;

let dir = '';
let leftover: number[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lolping-agent-'));
  await mkdir(path.join(dir, 'ask'));
});

afterEach(async () => {
  for (const pid of leftover) if (alive(pid)) process.kill(pid);
  leftover = [];
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sizeOf = (f: string): number => (existsSync(f) ? statSync(f).size : 0);

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agent-1', kind: 'agent', name: 'Agent', tagColor: 0, tagColorCustom: null, preset: 'custom',
    command: process.execPath, customArgs: [FAKE], folder: { kind: 'fixed', path: dir }, timeoutS: 300, ...over,
  };
}

function spec(): AgentRunSpec {
  const askDir = path.join(dir, 'ask');
  return {
    prompt: agentPrompt(askDir), askDir, mcpConfigPath: path.join(dir, 'mcp.json'),
    bridge: {
      command: process.execPath, args: [path.join(dir, 'app', 'out', 'main', 'index.js'), '--mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1', LOLPING_PIPE: '\\\\.\\pipe\\lolping-0123', LOLPING_DATA: path.join(dir, 'data'), LOLPING_ASK: 'ask-1.ab' },
    },
    resume: null,
  };
}

/** The test's own environment with PATH replaced, whatever case the key has. */
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v;
  return { ...env, PATH: [dir, process.env.PATH ?? ''].join(path.delimiter), ...extra };
}

/** Puts `bin` on PATH as a launcher for the fake agent: a .cmd shim on Windows, a shell script elsewhere. */
async function installAgent(bin: string): Promise<void> {
  if (win) {
    await writeFile(path.join(dir, `${bin}.cmd`), `@"${process.execPath}" "${FAKE}" %*\r\n`);
  } else {
    await writeFile(path.join(dir, bin), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  }
}

const realRunner = (): AgentRunner => new AgentRunner({
  spawn, platform, killTree: killProcessTree(platform), writeFile: (p, t) => writeFile(p, t),
});

const script = (lines: string[], extra: Record<string, string> = {}): Record<string, string> => ({
  FAKE_AGENT_LINES: JSON.stringify(lines), ...extra,
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  finish(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }
}

interface SpawnCall { file: string; args: readonly string[]; options: SpawnOptions }

/** A spawn that records its arguments and starts (or fails to start) a FakeChild. */
function fakeSpawn(fails = false) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const fn = (file: string, args: readonly string[], options: SpawnOptions): FakeChild => {
    const child = new FakeChild(4000 + children.length);
    calls.push({ file, args, options });
    children.push(child);
    process.nextTick(() => (fails ? child.emit('error', new Error('spawn EACCES')) : child.emit('spawn')));
    return child;
  };
  return { calls, children, spawn: fn as unknown as typeof spawn };
}

function spyRunner(fails = false) {
  const fake = fakeSpawn(fails);
  const killed: number[] = [];
  const written: [string, string][] = [];
  const runner = new AgentRunner({
    spawn: fake.spawn, platform, killTree: (pid) => killed.push(pid),
    writeFile: async (p, t) => { written.push([p, t]); },
  });
  return { runner, killed, written, ...fake };
}

/** An empty file where the runner looks for `bin`; the spy never runs it. */
async function placeholder(bin: string): Promise<string> {
  const file = path.join(dir, win ? `${bin}.exe` : bin);
  await writeFile(file, '', { mode: 0o755 });
  return file;
}

describe('AgentRunner', () => {
  it('reads the session id and ends with the exit code', async () => {
    await installAgent('claude');
    const run = await realRunner().start(profile({ preset: 'claude', command: 'claude' }), spec(), dir, envWith(script([
      '{"type":"system","subtype":"init","session_id":"s-1"}',
      'not json at all',
      '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s-2"}',
    ], { FAKE_AGENT_EXIT: '7' })));
    const result = await run.done;
    expect(result).toMatchObject({ code: 7, session: 's-2', error: null });
    expect(result.tail).toContain('not json at all');
  }, SLOW);

  it('fails with the agent\'s result text when it reports an error', async () => {
    await installAgent('claude');
    const run = await realRunner().start(profile({ preset: 'claude', command: 'claude' }), spec(), dir, envWith(script([
      '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"s-9"}',
    ], { FAKE_AGENT_EXIT: '1', FAKE_AGENT_STDERR: 'a warning first\n' })));
    expect(await run.done).toMatchObject({ code: 1, session: 's-9', error: 'Not logged in · Please run /login' });
  }, SLOW);

  it('takes the first stderr line when the agent\'s error has no text', async () => {
    await installAgent('dsh');
    const run = await realRunner().start(profile({ preset: 'dsh', command: 'dsh' }), spec(), dir, envWith(script([
      '{"type":"session","sessionId":"d-1","cwd":"x"}',
      '{"type":"turn_end","reason":{"kind":"error"}}',
    ], { FAKE_AGENT_EXIT: '1', FAKE_AGENT_STDERR: '\n   \ndsh: MISSING_CREDENTIAL: llm-deepseek: no API key\nmore\n' })));
    expect(await run.done).toMatchObject({
      code: 1, session: 'd-1', error: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key',
    });
  }, SLOW);

  it('keeps only the last 8 KB of output', async () => {
    const run = await realRunner().start(profile(), spec(), dir, envWith(script(['first-line', '%PAD%', 'last-line'], {
      FAKE_AGENT_PAD: '20000', FAKE_AGENT_STDERR: 'stderr-first\n%PAD%\nstderr-last\n',
    })));
    const { tail, error } = await run.done;
    expect(tail).toContain('last-line');
    expect(tail).toContain('stderr-last');
    expect(tail).not.toContain('first-line');
    expect(tail).not.toContain('stderr-first');
    expect(tail.length).toBeLessThanOrEqual(2 * 8192 + 1);
    // The error line comes from the start of stderr even when the tail no longer has it.
    expect(error).toBe('stderr-first');
  }, SLOW);

  it('skips a stdout line over 1 MB and reads on', async () => {
    await installAgent('claude');
    const run = await realRunner().start(profile({ preset: 'claude', command: 'claude' }), spec(), dir, envWith(script([
      '{"type":"system","session_id":"s-1"}',
      '{"type":"system","session_id":"too-big","pad":"%PAD%"}',
      '{"type":"result","is_error":true,"result":"after the long line"}',
    ], { FAKE_AGENT_PAD: String(1024 * 1024 + 10) })));
    expect(await run.done).toMatchObject({ session: 's-1', error: 'after the long line' });
  }, SLOW);

  it('throws notFound for a command that is not on PATH', async () => {
    const { runner, calls, written } = spyRunner();
    const p = profile({ preset: 'claude', command: 'no-such-agent-here' });
    const start = runner.start(p, spec(), dir, { PATH: dir });
    await expect(start).rejects.toBeInstanceOf(AgentStartError);
    await expect(start).rejects.toMatchObject({ kind: 'notFound', message: 'Couldn\'t find no-such-agent-here' });
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('throws noFolder for a working folder that is not there, before it starts anything', async () => {
    await placeholder('claude');
    const { runner, calls, written } = spyRunner();
    const p = profile({ preset: 'claude', command: 'claude' });
    const gone = path.join(dir, 'gone');
    await expect(runner.start(p, spec(), gone, { PATH: dir })).rejects.toMatchObject({ kind: 'noFolder' });
    const file = path.join(dir, 'a-file');
    await writeFile(file, '');
    await expect(runner.start(p, spec(), file, { PATH: dir })).rejects.toMatchObject({ kind: 'noFolder' });
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('throws spawn when the process fails to start', async () => {
    await placeholder('claude');
    const { runner } = spyRunner(true);
    const start = runner.start(profile({ preset: 'claude', command: 'claude' }), spec(), dir, { PATH: dir });
    await expect(start).rejects.toMatchObject({ kind: 'spawn', message: 'spawn EACCES' });
  });

  it('kills the process tree on cancel', async () => {
    const beat = path.join(dir, 'heartbeat.txt');
    const run = await realRunner().start(profile(), spec(), dir, envWith({ FAKE_AGENT_CHILD_HEARTBEAT: beat }));
    await until(() => sizeOf(beat) > 12, 'the heartbeat');
    const child = Number(readFileSync(beat, 'utf8').split('\n')[0]);
    leftover.push(child);
    run.kill();
    await run.done;
    await until(() => !alive(child), 'the agent\'s child to end');
    const size = sizeOf(beat);
    await new Promise((r) => setTimeout(r, 150));
    expect(sizeOf(beat)).toBe(size);
  }, KILL_SLOW);

  it('gives the latest session id while the agent still runs', async () => {
    await placeholder('claude');
    const { runner, children } = spyRunner();
    const run = await runner.start(profile({ preset: 'claude', command: 'claude' }), spec(), dir, { PATH: dir });
    expect(run.session()).toBeNull();
    children[0]?.stdout.write('{"type":"system","subtype":"init","session_id":"s-1"}\n');
    await until(() => run.session() === 's-1', 'the first session');
    children[0]?.stdout.write('{"type":"result","is_error":false,"session_id":"s-2"}\n');
    await until(() => run.session() === 's-2', 'the second session');
    children[0]?.finish(0);
    expect((await run.done).session).toBe('s-2');
  });

  it('skips the warnings Node prints when it takes the error from stderr', async () => {
    await placeholder('claude');
    const { runner, children } = spyRunner();
    const run = await runner.start(profile({ preset: 'claude', command: 'claude' }), spec(), dir, { PATH: dir });
    children[0]?.stderr.write([
      '(node:12345) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
      '(Use `node --trace-deprecation ...` to show where the warning was created)',
      '(node:12345) ExperimentalWarning: SQLite is an experimental feature',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      'Error: Invalid API key',
      '',
    ].join('\n'));
    children[0]?.finish(1);
    expect((await run.done).error).toBe('Error: Invalid API key');
  });

  it('gives no error when stderr holds only warnings from Node', async () => {
    await placeholder('claude');
    const { runner, children } = spyRunner();
    const run = await runner.start(profile({ preset: 'claude', command: 'claude' }), spec(), dir, { PATH: dir });
    children[0]?.stderr.write('(node:1) Warning: something \n(Use `node --trace-warnings ...` to show where)\n');
    children[0]?.finish(0);
    expect((await run.done).error).toBeNull();
  });

  it('kills each live run once, and not after it ended', async () => {
    await placeholder('claude');
    const { runner, children, killed } = spyRunner();
    const p = profile({ preset: 'claude', command: 'claude' });
    const a = await runner.start(p, spec(), dir, { PATH: dir });
    await runner.start(p, spec(), dir, { PATH: dir });
    const c = await runner.start(p, spec(), dir, { PATH: dir });
    const [childA, childB, childC] = children;
    childC?.finish(0);
    await c.done;
    a.kill();
    runner.killAll();
    a.kill();
    c.kill();
    expect(killed).toEqual([childA?.pid, childB?.pid]);
  });

  it('never puts the ask text on the command line', async () => {
    const s = spec();
    for (const id of AGENT_PRESET_IDS) {
      const preset = AGENT_PRESETS[id];
      const file = await placeholder(preset.bin);
      const { runner, calls, written } = spyRunner();
      await runner.start(profile({ preset: id, command: preset.bin }), s, dir, { PATH: dir, HOME: 'home' });
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.file, id).toBe(file);
      expect(call?.args, id).toEqual(preset.args(s));
      expect(call?.options, id).toMatchObject({
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !win, windowsVerbatimArguments: false,
        env: {
          PATH: dir, HOME: 'home', ...preset.env(s), LOLPING_PIPE: s.bridge.env.LOLPING_PIPE,
          LOLPING_DATA: s.bridge.env.LOLPING_DATA, LOLPING_ASK: s.bridge.env.LOLPING_ASK, LOLPING_ASK_DIR: s.askDir,
        },
      });
      const config = preset.configFile(s);
      expect(written, id).toEqual(config === null ? [] : [[s.mcpConfigPath, config]]);
    }
  });

  it('keeps ELECTRON_RUN_AS_NODE out of the environment of every agent', async () => {
    const s = spec();
    expect(s.bridge.env.ELECTRON_RUN_AS_NODE).toBe('1');
    for (const id of AGENT_PRESET_IDS) {
      const preset = AGENT_PRESETS[id];
      await placeholder(preset.bin);
      const { runner, calls } = spyRunner();
      // Even a switch lolPing was itself started with doesn't reach the agent.
      await runner.start(profile({ preset: id, command: preset.bin }), s, dir, { PATH: dir, ELECTRON_RUN_AS_NODE: '1' });
      const env = calls[0]?.options.env ?? {};
      expect(env.ELECTRON_RUN_AS_NODE, id).toBeUndefined();
      expect(env, id).toMatchObject({
        LOLPING_PIPE: s.bridge.env.LOLPING_PIPE, LOLPING_DATA: s.bridge.env.LOLPING_DATA,
        LOLPING_ASK: s.bridge.env.LOLPING_ASK, LOLPING_ASK_DIR: s.askDir,
      });
    }
  });

  it('fills {prompt}, {askDir} and {mcpConfig} in a custom profile\'s lines', async () => {
    const s = spec();
    const { runner, calls, written } = spyRunner();
    const p = profile({ customArgs: ['--ask={askDir}', '{prompt}', '--mcp', '{mcpConfig}', 'run', '{other}'] });
    await runner.start(p, s, dir, { PATH: dir });
    expect(calls[0]?.file).toBe(process.execPath);
    expect(calls[0]?.args).toEqual([`--ask=${s.askDir}`, s.prompt, '--mcp', s.mcpConfigPath, 'run', '{other}']);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]?.[1] ?? '')).toEqual({
      mcpServers: { lolping: { type: 'stdio', command: s.bridge.command, args: s.bridge.args, env: s.bridge.env } },
    });
  });
});

describe('AgentRunner when stopping a run fails', () => {
  it('still stops the other runs when killing one throws', async () => {
    await placeholder('claude');
    const fake = fakeSpawn();
    const killed: number[] = [];
    const runner = new AgentRunner({
      spawn: fake.spawn, platform,
      killTree: (pid) => {
        killed.push(pid);
        if (pid === 4000) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      },
      writeFile: async () => undefined,
    });
    const p = profile({ preset: 'claude', command: 'claude' });
    await runner.start(p, spec(), dir, { PATH: dir });
    await runner.start(p, spec(), dir, { PATH: dir });
    await runner.start(p, spec(), dir, { PATH: dir });
    expect(() => runner.killAll()).not.toThrow();
    expect(killed).toEqual([4000, 4001, 4002]);
  });
});

describe('isExecutable', () => {
  it('is false for a folder and for a path that is not there', async () => {
    expect(isExecutable(dir)).toBe(false);
    expect(isExecutable(path.join(dir, 'missing'))).toBe(false);
  });

  it('is true for a file that can be run', async () => {
    const file = path.join(dir, win ? 'tool.exe' : 'tool');
    await writeFile(file, '', { mode: 0o755 });
    expect(isExecutable(file)).toBe(true);
  });

  it.runIf(!win)('is false for a file without the execute bit, such as a README on PATH', async () => {
    const file = path.join(dir, 'claude');
    await writeFile(file, '#!/bin/sh\n', { mode: 0o644 });
    await chmod(file, 0o644);
    expect(isExecutable(file)).toBe(false);
    await chmod(file, 0o755);
    expect(isExecutable(file)).toBe(true);
  });
});

describe('killProcessTree on macOS and Linux', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const signals = (kill: ReturnType<typeof vi.spyOn>): unknown[] => kill.mock.calls.map((c: unknown[]) => c.slice(0, 2));

  it.each(['mac', 'linux'] as const)('signals the whole process group on %s, then kills what is left', (name) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    killProcessTree(name)(4321);
    expect(signals(kill)).toEqual([[-4321, 'SIGTERM']]);
    vi.advanceTimersByTime(2000);
    expect(signals(kill)).toEqual([[-4321, 'SIGTERM'], [-4321, 0], [-4321, 'SIGKILL']]);
  });

  it('does not send SIGKILL once the group is gone', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      return true;
    });
    killProcessTree('mac')(4321);
    vi.advanceTimersByTime(2000);
    expect(signals(kill)).toEqual([[-4321, 'SIGTERM'], [-4321, 0]]);
  });

  it('does not throw when the group is not ours to signal', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    expect(() => killProcessTree('mac')(4321)).not.toThrow();
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(kill).toHaveBeenCalled();
  });
});
