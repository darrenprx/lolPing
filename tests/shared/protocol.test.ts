import { describe, expect, it } from 'vitest';
import { configCommand, parseHelperLine, serializeCommand } from '../../src/shared/protocol';
import { DEFAULT_FEATURES } from '../../src/shared/features';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

describe('parseHelperLine', () => {
  it('parses every event type', () => {
    expect(parseHelperLine('{"type":"ready","version":1}')).toEqual({ type: 'ready', version: 1 });
    expect(parseHelperLine('{"type":"wheelOpen","x":10,"y":-20}')).toEqual({ type: 'wheelOpen', x: 10, y: -20, wheel: 'ping' });
    expect(parseHelperLine('{"type":"wheelMove","x":1,"y":2}')).toEqual({ type: 'wheelMove', x: 1, y: 2, wheel: 'ping' });
    expect(parseHelperLine('{"type":"wheelRelease","x":1,"y":2}')).toEqual({ type: 'wheelRelease', x: 1, y: 2, wheel: 'ping' });
    expect(parseHelperLine('{"type":"click","x":5,"y":6}')).toEqual({ type: 'click', x: 5, y: 6, wheel: 'ping' });
    expect(parseHelperLine('{"type":"cancel"}')).toEqual({ type: 'cancel' });
    expect(parseHelperLine('{"type":"toggled","enabled":false}')).toEqual({ type: 'toggled', enabled: false });
    expect(parseHelperLine('{"type":"textRequested"}')).toEqual({ type: 'textRequested' });
    expect(parseHelperLine('{"type":"panel","show":true}')).toEqual({ type: 'panel', show: true });
    expect(parseHelperLine('{"type":"panel","show":false}')).toEqual({ type: 'panel', show: false });
    expect(parseHelperLine('{"type":"foregroundApp","name":"Photoshop.exe"}')).toEqual({ type: 'foregroundApp', name: 'Photoshop.exe' });
    expect(parseHelperLine('{"type":"appList","apps":[{"name":"Photoshop.exe","path":"C:\\\\Adobe\\\\Photoshop.exe"},{"name":"chrome","path":"/opt/chrome"}]}'))
      .toEqual({ type: 'appList', apps: [{ name: 'Photoshop.exe', path: 'C:\\Adobe\\Photoshop.exe' }, { name: 'chrome', path: '/opt/chrome' }] });
    expect(parseHelperLine('{"type":"appList","apps":[{"name":"no path"},{"path":"C:\\\\b.exe"},"text",{"name":"","path":""}]}'))
      .toEqual({ type: 'appList', apps: [{ name: '', path: '' }] });
    expect(parseHelperLine('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' });
    expect(parseHelperLine('{"type":"error","code":"noAccess","message":"x"}')).toEqual({ type: 'error', code: 'noAccess', message: 'x' });
    expect(parseHelperLine('{"type":"sim","swallow":true,"inject":"down:left"}')).toEqual({ type: 'sim', swallow: true, inject: 'down:left' });
  });

  it('says which wheel a point event belongs to, defaulting to the ping wheel', () => {
    expect(parseHelperLine('{"type":"wheelOpen","x":1,"y":2,"wheel":"emote"}')).toEqual({ type: 'wheelOpen', x: 1, y: 2, wheel: 'emote' });
    expect(parseHelperLine('{"type":"click","x":1,"y":2,"wheel":"emote"}')).toEqual({ type: 'click', x: 1, y: 2, wheel: 'emote' });
    expect(parseHelperLine('{"type":"wheelMove","x":1,"y":2,"wheel":"ping"}')).toEqual({ type: 'wheelMove', x: 1, y: 2, wheel: 'ping' });
    for (const wheel of ['"EMOTE"', '"mystery"', '1', 'true', 'null', '{}']) {
      expect(parseHelperLine(`{"type":"wheelRelease","x":1,"y":2,"wheel":${wheel}}`), wheel)
        .toEqual({ type: 'wheelRelease', x: 1, y: 2, wheel: 'ping' });
    }
  });

  it('rejects malformed lines', () => {
    for (const line of ['', 'nope', '42', 'null', '{"type":"wheelOpen","x":1}', '{"type":"click","x":1.5,"y":2}',
      '{"type":"toggled"}', '{"type":"panel"}', '{"type":"panel","show":"yes"}', '{"type":"foregroundApp"}', '{"type":"appList"}',
      '{"type":"appList","apps":"x"}', '{"type":"mystery"}', '{"x":1,"y":2}']) {
      expect(parseHelperLine(line), line).toBeNull();
    }
  });
});

describe('commands', () => {
  it('builds a flat config command for named triggers', () => {
    expect(configCommand(DEFAULT_SETTINGS, true)).toEqual({
      type: 'config', trigger: 'alt', triggerVk: 0, clickPing: false, gameCheck: true, skipApps: '',
      emoteTrigger: 'ctrl', emoteTriggerVk: 0, emoteClick: false, dragThresholdPx: 8,
      toggleMods: 3, toggleVk: 0x50, textMods: 2, textVk: 0, panelVk: 0, enabled: true,
    });
  });

  it('sends the skip list as one comma-joined name', () => {
    expect(configCommand({ ...DEFAULT_SETTINGS, skipApps: ['photoshop', 'idea64'] }, true))
      .toMatchObject({ skipApps: 'photoshop,idea64' });
  });

  it('sends textVk 0 outside a room', () => {
    expect(configCommand(DEFAULT_SETTINGS, true, { text: false, panel: false })).toMatchObject({ textMods: 2, textVk: 0 });
  });

  it('sends the text shortcut while the text key is live', () => {
    expect(configCommand(DEFAULT_SETTINGS, true, { text: true, panel: false })).toMatchObject({ textMods: 2, textVk: 0x54 });
  });

  it('sends panelVk 0 outside a room and the panel key inside one', () => {
    expect(configCommand(DEFAULT_SETTINGS, true)).toMatchObject({ panelVk: 0 });
    expect(configCommand(DEFAULT_SETTINGS, true, { text: false, panel: false })).toMatchObject({ panelVk: 0 });
    expect(configCommand(DEFAULT_SETTINGS, true, { text: false, panel: true })).toMatchObject({ panelVk: 9 });
    expect(configCommand({ ...DEFAULT_SETTINGS, panelKey: 0xc0 }, true, { text: true, panel: true })).toMatchObject({ panelVk: 0xc0 });
  });

  it('builds a config command for a custom key trigger', () => {
    const c = configCommand({ ...DEFAULT_SETTINGS, trigger: { vk: 0x56 } }, false);
    expect(c).toMatchObject({ type: 'config', trigger: 'vk', triggerVk: 0x56, enabled: false });
  });

  it('sends the emote key: off, a named trigger, or a custom key', () => {
    expect(configCommand({ ...DEFAULT_SETTINGS, emoteTrigger: 'off' }, true))
      .toMatchObject({ emoteTrigger: 'off', emoteTriggerVk: 0, emoteClick: false });
    expect(configCommand({ ...DEFAULT_SETTINGS, emoteTrigger: 'mouse5', emoteClick: true }, true))
      .toMatchObject({ emoteTrigger: 'mouse5', emoteTriggerVk: 0, emoteClick: true });
    expect(configCommand({ ...DEFAULT_SETTINGS, emoteTrigger: { vk: 0x54 } }, true))
      .toMatchObject({ trigger: 'alt', triggerVk: 0, emoteTrigger: 'vk', emoteTriggerVk: 0x54 });
  });

  it('sends no emote key while emotes are off', () => {
    const c = configCommand({ ...DEFAULT_SETTINGS, emoteClick: true, features: { ...DEFAULT_FEATURES, emotes: false } }, true);
    expect(c).toMatchObject({ emoteTrigger: 'off', emoteTriggerVk: 0, emoteClick: false });
  });

  it('keeps the emote key while only rooms are off', () => {
    const c = configCommand({ ...DEFAULT_SETTINGS, features: { ...DEFAULT_FEATURES, rooms: false } }, true);
    expect(c).toMatchObject({ emoteTrigger: 'ctrl' });
  });

  it('serializes one command per line', () => {
    const line = serializeCommand({ type: 'suspend', on: true });
    expect(line).toBe('{"type":"suspend","on":true}\n');
    expect(line.indexOf('\n')).toBe(line.length - 1);
  });
});
