import { describe, expect, it } from 'vitest';
import { configCommand, parseHelperLine, serializeCommand } from '../../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

describe('parseHelperLine', () => {
  it('parses every event type', () => {
    expect(parseHelperLine('{"type":"ready","version":1}')).toEqual({ type: 'ready', version: 1 });
    expect(parseHelperLine('{"type":"wheelOpen","x":10,"y":-20}')).toEqual({ type: 'wheelOpen', x: 10, y: -20 });
    expect(parseHelperLine('{"type":"wheelMove","x":1,"y":2}')).toEqual({ type: 'wheelMove', x: 1, y: 2 });
    expect(parseHelperLine('{"type":"wheelRelease","x":1,"y":2}')).toEqual({ type: 'wheelRelease', x: 1, y: 2 });
    expect(parseHelperLine('{"type":"click","x":5,"y":6}')).toEqual({ type: 'click', x: 5, y: 6 });
    expect(parseHelperLine('{"type":"cancel"}')).toEqual({ type: 'cancel' });
    expect(parseHelperLine('{"type":"toggled","enabled":false}')).toEqual({ type: 'toggled', enabled: false });
    expect(parseHelperLine('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' });
    expect(parseHelperLine('{"type":"error","code":"conflict","message":"x"}')).toEqual({ type: 'error', code: 'conflict', message: 'x' });
    expect(parseHelperLine('{"type":"sim","swallow":true,"inject":"down:left"}')).toEqual({ type: 'sim', swallow: true, inject: 'down:left' });
  });

  it('rejects malformed lines', () => {
    for (const line of ['', 'nope', '42', 'null', '{"type":"wheelOpen","x":1}', '{"type":"click","x":1.5,"y":2}',
      '{"type":"toggled"}', '{"type":"mystery"}', '{"x":1,"y":2}']) {
      expect(parseHelperLine(line), line).toBeNull();
    }
  });
});

describe('commands', () => {
  it('builds a flat config command for named triggers', () => {
    expect(configCommand(DEFAULT_SETTINGS, true)).toEqual({
      type: 'config', trigger: 'alt', triggerVk: 0, clickPing: false, dragThresholdPx: 8,
      toggleMods: 3, toggleVk: 0x50, enabled: true,
    });
  });

  it('builds a config command for a custom key trigger', () => {
    const c = configCommand({ ...DEFAULT_SETTINGS, trigger: { vk: 0x56 } }, false);
    expect(c).toMatchObject({ type: 'config', trigger: 'vk', triggerVk: 0x56, enabled: false });
  });

  it('serializes one command per line', () => {
    const line = serializeCommand({ type: 'suspend', on: true });
    expect(line).toBe('{"type":"suspend","on":true}\n');
    expect(line.indexOf('\n')).toBe(line.length - 1);
  });
});
