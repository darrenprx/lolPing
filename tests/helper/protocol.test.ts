import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { parseHelperLine, type HelperEvent } from '../../src/shared/protocol';

const exe = resolve(__dirname, '../../native/hook-helper/build', process.platform === 'win32' ? 'hook-helper.exe' : 'hook-helper');
const ALT = 164, CTRL = 162, KEY_P = 80;
const config = {
  type: 'config', trigger: 'alt', triggerVk: 0, clickPing: false, emoteTrigger: 'ctrl', emoteTriggerVk: 0, emoteClick: false,
  dragThresholdPx: 8, toggleMods: 3, toggleVk: 80, enabled: true,
};

async function simulate(lines: object[]): Promise<HelperEvent[]> {
  expect(existsSync(exe), 'run `npm run build:helper` first').toBe(true);
  const child = spawn(exe, ['--simulate'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const events: HelperEvent[] = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (l) => {
    const e = parseHelperLine(l);
    if (e) events.push(e);
  });
  for (const l of lines) child.stdin.write(`${JSON.stringify(l)}\n`);
  child.stdin.end();
  await once(rl, 'close');
  return events;
}

const sim = (ev: string, extra: Record<string, unknown> = {}) => ({ type: 'sim', ev, ...extra });

describe('hook-helper --simulate', () => {
  it('announces itself first', async () => {
    const events = await simulate([]);
    expect(events[0]).toEqual({ type: 'ready', version: 2 });
  });

  it('opens and releases the wheel on Alt+drag', async () => {
    const events = await simulate([
      config,
      sim('kdown', { vk: ALT }),
      sim('mdown', { btn: 'left', x: 100, y: 100 }),
      sim('move', { x: 130, y: 100 }),
      sim('mup', { btn: 'left', x: 140, y: 90 }),
    ]);
    const protocol = events.filter((e) => e.type !== 'sim' && e.type !== 'ready');
    expect(protocol).toEqual([
      { type: 'wheelOpen', x: 100, y: 100, wheel: 'ping' },
      { type: 'wheelMove', x: 130, y: 100, wheel: 'ping' },
      { type: 'wheelRelease', x: 140, y: 90, wheel: 'ping' },
    ]);
    const simLines = events.filter((e) => e.type === 'sim');
    expect(simLines.map((e) => (e.type === 'sim' ? e.swallow : null))).toEqual([false, true, false, true]);
  });

  it('opens and releases the emote wheel on Ctrl+drag', async () => {
    const events = await simulate([
      config,
      sim('kdown', { vk: CTRL }),
      sim('mdown', { btn: 'left', x: 100, y: 100 }),
      sim('move', { x: 130, y: 100 }),
      sim('mup', { btn: 'left', x: 140, y: 90 }),
    ]);
    const protocol = events.filter((e) => e.type !== 'sim' && e.type !== 'ready');
    expect(protocol).toEqual([
      { type: 'wheelOpen', x: 100, y: 100, wheel: 'emote' },
      { type: 'wheelMove', x: 130, y: 100, wheel: 'emote' },
      { type: 'wheelRelease', x: 140, y: 90, wheel: 'emote' },
    ]);
    const simLines = events.filter((e) => e.type === 'sim');
    expect(simLines.map((e) => (e.type === 'sim' ? e.swallow : null))).toEqual([false, true, false, true]);
  });

  it('leaves Ctrl+drag alone when the emote key is off', async () => {
    const events = await simulate([
      { ...config, emoteTrigger: 'off' },
      sim('kdown', { vk: CTRL }),
      sim('mdown', { btn: 'left', x: 100, y: 100 }),
      sim('move', { x: 130, y: 100 }),
      sim('mup', { btn: 'left', x: 140, y: 90 }),
    ]);
    expect(events.filter((e) => e.type !== 'sim' && e.type !== 'ready')).toEqual([]);
    expect(events.filter((e) => e.type === 'sim').every((e) => e.type === 'sim' && !e.swallow)).toBe(true);
  });

  it('replays a plain Alt+click', async () => {
    const events = await simulate([
      config,
      sim('kdown', { vk: ALT }),
      sim('mdown', { btn: 'left', x: 5, y: 5 }),
      sim('mup', { btn: 'left', x: 5, y: 5 }),
    ]);
    expect(events.at(-1)).toEqual({ type: 'sim', swallow: true, inject: 'down:left,up:left' });
  });

  it('reports the toggle hotkey', async () => {
    const events = await simulate([
      config, sim('kdown', { vk: CTRL }), sim('kdown', { vk: ALT }), sim('kdown', { vk: KEY_P }),
    ]);
    expect(events).toContainEqual({ type: 'toggled', enabled: false });
  });

  it('reports invalid commands as errors', async () => {
    const events = await simulate([{ type: 'bogus' }]);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
