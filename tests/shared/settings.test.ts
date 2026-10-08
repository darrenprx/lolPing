import { describe, expect, it } from 'vitest';
import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL } from '../../src/shared/emoteCatalog';
import { MOD } from '../../src/shared/keys';
import { formatRoomCode, makeRoomCode } from '../../src/shared/roomCode';
import {
  DEFAULT_SETTINGS, keyboardTriggers, mergeSettings, normalizeSettings, overlaySettings, patchClashes, rendererPatch, sameTrigger,
  triggerLabel, triggersClash,
} from '../../src/shared/settings';

describe('normalizeSettings', () => {
  it('returns defaults for missing or non-object input', () => {
    for (const raw of [undefined, null, 42, 'x', [1, 2]]) expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values', () => {
    const s = normalizeSettings({ ...DEFAULT_SETTINGS, trigger: 'mouse4', volume: 30, clickPing: true });
    expect(s.trigger).toBe('mouse4');
    expect(s.volume).toBe(30);
    expect(s.clickPing).toBe(true);
  });

  it('clamps and rounds numbers to their limits', () => {
    const s = normalizeSettings({ dragThresholdPx: 0, pingSizePx: 999, pingDurationS: 3.27, volume: 55.6 });
    expect(s.dragThresholdPx).toBe(2);
    expect(s.pingSizePx).toBe(220);
    expect(s.pingDurationS).toBe(3.3);
    expect(s.volume).toBe(56);
  });

  it('replaces wrong types and non-finite numbers with defaults', () => {
    const s = normalizeSettings({ volume: Number.NaN, muted: 'yes', pingSizePx: '120', launchAtStartup: 1 });
    expect(s.volume).toBe(DEFAULT_SETTINGS.volume);
    expect(s.muted).toBe(false);
    expect(s.pingSizePx).toBe(DEFAULT_SETTINGS.pingSizePx);
    expect(s.launchAtStartup).toBe(false);
  });

  it('accepts custom-key triggers and rejects unknown ones', () => {
    expect(normalizeSettings({ trigger: { vk: 0x56 } }).trigger).toEqual({ vk: 0x56 });
    expect(normalizeSettings({ trigger: { vk: 300 } }).trigger).toBe('alt');
    expect(normalizeSettings({ trigger: 'meta' }).trigger).toBe('alt');
  });

  it('requires a modifier and a valid key in the toggle hotkey', () => {
    expect(normalizeSettings({ toggleHotkey: { mods: MOD.ctrl, vk: 0x4b } }).toggleHotkey).toEqual({ mods: 1, vk: 0x4b });
    expect(normalizeSettings({ toggleHotkey: { mods: 0, vk: 0x4b } }).toggleHotkey).toEqual(DEFAULT_SETTINGS.toggleHotkey);
    expect(normalizeSettings({ toggleHotkey: { mods: 3, vk: 0 } }).toggleHotkey).toEqual(DEFAULT_SETTINGS.toggleHotkey);
    expect(normalizeSettings({ toggleHotkey: { mods: 99, vk: 0x4b } }).toggleHotkey).toEqual(DEFAULT_SETTINGS.toggleHotkey);
  });

  it('rejects a Shift-only toggle hotkey (it would swallow ordinary typing)', () => {
    expect(normalizeSettings({ toggleHotkey: { mods: MOD.shift, vk: 0x41 } }).toggleHotkey).toEqual(DEFAULT_SETTINGS.toggleHotkey);
    expect(normalizeSettings({ toggleHotkey: { mods: MOD.ctrl | MOD.shift, vk: 0x41 } }).toggleHotkey).toEqual({ mods: 5, vk: 0x41 });
    expect(normalizeSettings({ toggleHotkey: { mods: MOD.alt | MOD.shift, vk: 0x41 } }).toggleHotkey).toEqual({ mods: 6, vk: 0x41 });
    expect(normalizeSettings({ toggleHotkey: { mods: MOD.win | MOD.shift, vk: 0x41 } }).toggleHotkey).toEqual({ mods: 12, vk: 0x41 });
    expect(normalizeSettings({ toggleHotkey: { mods: MOD.win, vk: 0x41 } }).toggleHotkey).toEqual({ mods: 8, vk: 0x41 });
  });

  it('keeps a valid custom wheel and click ping', () => {
    const wheel = ['bait', 'push', 'omw', 'allin', 'assist', 'needvision', 'missing', 'visioncleared'];
    const s = normalizeSettings({ wheel, clickPingId: 'danger' });
    expect(s.wheel).toEqual(wheel);
    expect(s.clickPingId).toBe('danger');
  });

  it('resets an invalid wheel to the default layout', () => {
    const dup = ['push', 'push', 'omw', 'allin', 'assist', 'needvision', 'missing', 'enemyvision'];
    for (const wheel of [dup, ['danger'], 'danger', [...DEFAULT_SETTINGS.wheel.slice(0, 7), 'nope'], undefined]) {
      expect(normalizeSettings({ wheel }).wheel).toEqual(DEFAULT_SETTINGS.wheel);
    }
  });

  it('resets an unknown click ping to the generic ping', () => {
    expect(normalizeSettings({ clickPingId: 'nope' }).clickPingId).toBe('generic');
    expect(normalizeSettings({ clickPingId: 3 }).clickPingId).toBe('generic');
  });

  it('does not share the default wheel array', () => {
    expect(normalizeSettings(undefined).wheel).not.toBe(DEFAULT_SETTINGS.wheel);
  });

  it('does not share the default hotkey object', () => {
    expect(normalizeSettings(undefined).toggleHotkey).not.toBe(DEFAULT_SETTINGS.toggleHotkey);
  });
});

describe('room settings', () => {
  const identity = { name: 'darren', color: 5 };

  it('fills missing room keys from the identity and defaults', () => {
    const s = normalizeSettings({}, 'win', identity);
    expect(s).toMatchObject({
      displayName: 'darren', tagColor: 5, incomingPingLimit: 5, allowInternet: true, rejoinRoom: true,
      lastRoomCode: null, roomMuted: false,
    });
  });

  it('defaults to Player and colour 0 without an identity', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ displayName: 'Player', tagColor: 0 });
  });

  it('clamps the incoming ping limit, 0 meaning unlimited', () => {
    expect(normalizeSettings({ incomingPingLimit: 0 }).incomingPingLimit).toBe(0);
    expect(normalizeSettings({ incomingPingLimit: 99 }).incomingPingLimit).toBe(20);
    expect(normalizeSettings({ incomingPingLimit: -3 }).incomingPingLimit).toBe(0);
    expect(normalizeSettings({ incomingPingLimit: 'x' }).incomingPingLimit).toBe(5);
  });

  it('replaces an invalid tag colour with the identity colour', () => {
    expect(normalizeSettings({ tagColor: 9 }, 'win', identity).tagColor).toBe(5);
    expect(normalizeSettings({ tagColor: 2 }, 'win', identity).tagColor).toBe(2);
  });

  it('sanitises the display name and falls back to the identity name', () => {
    expect(normalizeSettings({ displayName: '‮  Alex  ' }, 'win', identity).displayName).toBe('Alex');
    expect(normalizeSettings({ displayName: '   ' }, 'win', identity).displayName).toBe('darren');
    expect(normalizeSettings({ displayName: 'x'.repeat(40) }).displayName).toHaveLength(16);
    expect(mergeSettings(normalizeSettings({}, 'win', identity), { displayName: '' }, 'win', identity).displayName).toBe('darren');
  });

  it('keeps the last room code only when it is valid, in canonical form', () => {
    expect(normalizeSettings({ lastRoomCode: 'nope' }).lastRoomCode).toBeNull();
    expect(normalizeSettings({ lastRoomCode: 3 }).lastRoomCode).toBeNull();
    const code = makeRoomCode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(normalizeSettings({ lastRoomCode: formatRoomCode(code) }).lastRoomCode).toBe(code);
  });
});

describe('emote settings', () => {
  const hash = (c: string) => `c:${c.repeat(32)}`;
  const entry = (c: string, name = 'Mine', animated = false) => ({ id: hash(c), name, animated });

  it('emote defaults', () => {
    const s = normalizeSettings(undefined);
    expect(s).toMatchObject({
      emoteTrigger: 'ctrl', emoteClick: false, emoteSizePx: 150, emoteSound: true, customEmotes: [],
      emoteWheel: [...DEFAULT_EMOTE_WHEEL], clickEmoteId: DEFAULT_CLICK_EMOTE,
    });
    expect(DEFAULT_SETTINGS.trigger).not.toBe(DEFAULT_SETTINGS.emoteTrigger);
  });

  it('does not share the default emote arrays', () => {
    const s = normalizeSettings(undefined);
    expect(s.emoteWheel).not.toBe(DEFAULT_SETTINGS.emoteWheel);
    expect(s.customEmotes).not.toBe(DEFAULT_SETTINGS.customEmotes);
  });

  it('emote key clashing with the ping trigger turns off', () => {
    expect(normalizeSettings({ trigger: 'ctrl' }).emoteTrigger).toBe('off');
    expect(normalizeSettings({ trigger: 'ctrl', emoteTrigger: 'ctrl' }).emoteTrigger).toBe('off');
    expect(normalizeSettings({ trigger: { vk: 84 }, emoteTrigger: { vk: 84 } }).emoteTrigger).toBe('off');
    expect(normalizeSettings({ trigger: { vk: 84 }, emoteTrigger: { vk: 85 } }).emoteTrigger).toEqual({ vk: 85 });
    expect(normalizeSettings({ trigger: 'alt', emoteTrigger: 'shift' }).emoteTrigger).toBe('shift');
  });

  it('keeps off, and accepts mouse buttons and custom keys', () => {
    expect(normalizeSettings({ emoteTrigger: 'off' }).emoteTrigger).toBe('off');
    expect(normalizeSettings({ emoteTrigger: 'mouse4' }).emoteTrigger).toBe('mouse4');
    expect(normalizeSettings({ emoteTrigger: { vk: 0x56 } }).emoteTrigger).toEqual({ vk: 0x56 });
  });

  it('replaces an unusable emote key with the default one', () => {
    for (const emoteTrigger of ['meta', 7, null, { vk: 300 }, { vk: 'x' }]) {
      expect(normalizeSettings({ emoteTrigger }).emoteTrigger).toBe('ctrl');
    }
  });

  it('custom emote key equal to the pause key turns off', () => {
    expect(normalizeSettings({ emoteTrigger: { vk: 0x50 } }).emoteTrigger).toBe('off');
    expect(normalizeSettings({ emoteTrigger: { vk: 0x50 }, toggleHotkey: { mods: MOD.ctrl, vk: 0x4b } }).emoteTrigger).toEqual({ vk: 0x50 });
  });

  it('mac has no caps lock emote key', () => {
    expect(normalizeSettings({ emoteTrigger: 'capslock' }, 'mac').emoteTrigger).toBe('ctrl');
    expect(normalizeSettings({ emoteTrigger: 'off' }, 'mac').emoteTrigger).toBe('off');
    expect(normalizeSettings({ emoteTrigger: 'capslock' }, 'win').emoteTrigger).toBe('capslock');
  });

  it('custom emotes drop bad entries', () => {
    const raw = [
      entry('a'),
      { id: 'facepalm', name: 'Bundled id', animated: false },
      { id: 'c:abc', name: 'Short', animated: false },
      { id: hash('b'), name: 'Not a flag', animated: 'yes' },
      { id: hash('c'), name: 'No flag' },
      { id: hash('d'), animated: false },
      entry('a', 'Duplicate id'),
      'text', null, 7, [],
      entry('e', 'Kept', true),
    ];
    expect(normalizeSettings({ customEmotes: raw }).customEmotes).toEqual([entry('a'), entry('e', 'Kept', true)]);
    expect(normalizeSettings({ customEmotes: 'nope' }).customEmotes).toEqual([]);
  });

  it('custom emotes keep the first 24', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `c:${i.toString(16).padStart(32, '0')}`, name: `E${i}`, animated: false }));
    const kept = normalizeSettings({ customEmotes: many }).customEmotes;
    expect(kept).toHaveLength(24);
    expect(kept.map((c) => c.name)).toEqual(many.slice(0, 24).map((c) => c.name));
  });

  it('custom emote names are sanitised and cut to 24 code points', () => {
    const names = normalizeSettings({
      customEmotes: [
        entry('a', '‮  Cat  '), entry('b', 'x'.repeat(40)), entry('c', '\u{1f600}'.repeat(30)), entry('d', '   '), entry('e', 'a​b'),
      ],
    }).customEmotes.map((c) => c.name);
    // A name with nothing left gets the first characters of its id, which reads the same in every language.
    expect(names).toEqual(['Cat', 'x'.repeat(24), '\u{1f600}'.repeat(24), 'dddddd', 'ab']);
  });

  it('custom emotes are rebuilt from known fields only', () => {
    const [kept] = normalizeSettings({ customEmotes: [{ ...entry('a'), extra: 1 }] }).customEmotes;
    expect(kept).toEqual(entry('a'));
    expect(Object.keys(kept)).toEqual(['id', 'name', 'animated']);
  });

  it('keeps a wheel slot and centre that point at a known custom emote', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[3] = hash('a');
    const s = normalizeSettings({ customEmotes: [entry('a')], emoteWheel: wheel, clickEmoteId: hash('a') });
    expect(s.emoteWheel).toEqual(wheel);
    expect(s.clickEmoteId).toBe(hash('a'));
  });

  it('an emote wheel slot holding a custom ref that is not in customEmotes falls back', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[3] = hash('a');
    const s = normalizeSettings({ customEmotes: [entry('b')], emoteWheel: wheel, clickEmoteId: hash('a') });
    expect(s.emoteWheel).toEqual(DEFAULT_EMOTE_WHEEL);
    expect(s.clickEmoteId).toBe(DEFAULT_CLICK_EMOTE);
  });

  it('removing a custom emote through a patch repairs the wheel', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[5] = hash('a');
    const withCustom = normalizeSettings({ customEmotes: [entry('a')], emoteWheel: wheel });
    expect(mergeSettings(withCustom, { customEmotes: [] }).emoteWheel).toEqual(DEFAULT_EMOTE_WHEEL);
  });

  it('emoteSizePx clamps', () => {
    expect(normalizeSettings({ emoteSizePx: 10 }).emoteSizePx).toBe(80);
    expect(normalizeSettings({ emoteSizePx: 999 }).emoteSizePx).toBe(300);
    expect(normalizeSettings({ emoteSizePx: 201.4 }).emoteSizePx).toBe(201);
    expect(normalizeSettings({ emoteSizePx: 'big' }).emoteSizePx).toBe(150);
  });

  it('keeps the emote booleans', () => {
    const s = normalizeSettings({ emoteClick: true, emoteSound: false });
    expect([s.emoteClick, s.emoteSound]).toEqual([true, false]);
    const bad = normalizeSettings({ emoteClick: 1, emoteSound: 'no' });
    expect([bad.emoteClick, bad.emoteSound]).toEqual([false, true]);
  });
});

describe('emote key clashes', () => {
  const toggle = { mods: MOD.ctrl | MOD.alt, vk: 0x50 };
  const current = { ...DEFAULT_SETTINGS, trigger: 'alt' as const, emoteTrigger: 'ctrl' as const };

  it('compares triggers by name or key code', () => {
    expect(sameTrigger('alt', 'alt')).toBe(true);
    expect(sameTrigger('alt', 'ctrl')).toBe(false);
    expect(sameTrigger({ vk: 84 }, { vk: 84 })).toBe(true);
    expect(sameTrigger({ vk: 84 }, { vk: 85 })).toBe(false);
    expect(sameTrigger('alt', { vk: 84 })).toBe(false);
    expect(sameTrigger('off', 'off')).toBe(true);
  });

  it('treats the named Caps Lock trigger and a custom Caps Lock key as one key', () => {
    expect(sameTrigger('capslock', { vk: 0x14 })).toBe(true);
    expect(sameTrigger({ vk: 0x14 }, 'capslock')).toBe(true);
    expect(sameTrigger('capslock', 'capslock')).toBe(true);
    expect(sameTrigger('capslock', { vk: 0x15 })).toBe(false);
    expect(sameTrigger('capslock', 'off')).toBe(false);
    expect(sameTrigger({ vk: 0x14 }, 'alt')).toBe(false);
    expect(triggersClash('capslock', { vk: 0x14 }, toggle)).toBe(true);
    expect(patchClashes({ ...current, trigger: 'capslock' }, { emoteTrigger: { vk: 0x14 } })).toBe(true);
  });

  it('triggersClash never fires for an emote key that is off', () => {
    expect(triggersClash('alt', 'off', toggle)).toBe(false);
    expect(triggersClash('alt', 'alt', toggle)).toBe(true);
    expect(triggersClash('alt', { vk: 0x50 }, toggle)).toBe(true);
    expect(triggersClash('alt', { vk: 0x51 }, toggle)).toBe(false);
    expect(triggersClash('alt', 'ctrl', toggle)).toBe(false);
  });

  it('patchClashes', () => {
    expect(patchClashes(current, { trigger: 'ctrl' })).toBe(true);
    expect(patchClashes(current, { emoteTrigger: 'alt' })).toBe(true);
    expect(patchClashes(current, { emoteTrigger: 'shift' })).toBe(false);
    expect(patchClashes(current, { emoteTrigger: 'off' })).toBe(false);
    expect(patchClashes(current, { volume: 3 })).toBe(false);
    expect(patchClashes({ ...current, emoteTrigger: { vk: 84 } }, { toggleHotkey: { mods: 3, vk: 84 } })).toBe(true);
    expect(patchClashes({ ...current, emoteTrigger: { vk: 84 } }, { toggleHotkey: { mods: 3, vk: 85 } })).toBe(false);
  });

  it('patchClashes judges the merged result, so swapping both keys at once is fine', () => {
    expect(patchClashes(current, { trigger: 'ctrl', emoteTrigger: 'alt' })).toBe(false);
    expect(patchClashes(current, { trigger: 'shift', emoteTrigger: 'shift' })).toBe(true);
  });

  it('patchClashes reads the keys for the platform it is given', () => {
    const before = { ...current, trigger: 'alt' as const, emoteTrigger: 'off' as const };
    const patch = { trigger: 'capslock' as const, emoteTrigger: 'alt' as const };
    expect(patchClashes(before, patch, 'win')).toBe(false);
    // macOS has no Caps Lock trigger, so the ping trigger falls back to Alt and meets the emote key.
    expect(patchClashes(before, patch, 'mac')).toBe(true);
    // ...and an emote key of Caps Lock falls back to Ctrl there.
    expect(patchClashes({ ...current, trigger: 'ctrl' }, { emoteTrigger: 'capslock' }, 'win')).toBe(false);
    expect(patchClashes({ ...current, trigger: 'ctrl' }, { emoteTrigger: 'capslock' }, 'mac')).toBe(true);
  });

  it('a Caps Lock emote key clashes with a pause shortcut on Caps Lock, named or custom', () => {
    const capsPause = { mods: MOD.ctrl | MOD.alt, vk: 0x14 };
    expect(triggersClash('alt', 'capslock', capsPause)).toBe(true);
    expect(triggersClash('alt', { vk: 0x14 }, capsPause)).toBe(true);
    expect(triggersClash('alt', 'capslock', toggle)).toBe(false);
    expect(triggersClash('alt', 'ctrl', capsPause)).toBe(false); // a modifier trigger has no key code to clash with
    expect(patchClashes(current, { emoteTrigger: 'capslock', toggleHotkey: capsPause })).toBe(true);
    expect(patchClashes({ ...current, emoteTrigger: 'capslock' }, { toggleHotkey: capsPause })).toBe(true);
    expect(normalizeSettings({ trigger: 'alt', emoteTrigger: 'capslock', toggleHotkey: capsPause }).emoteTrigger).toBe('off');
  });

  it('patchClashes treats an unusable patch value the way normalizeSettings does', () => {
    // 'meta' is not a trigger, so the emote key would become the default Ctrl, which clashes with a Ctrl ping trigger.
    expect(patchClashes({ ...current, trigger: 'ctrl', emoteTrigger: 'off' }, { emoteTrigger: 'meta' as never })).toBe(true);
    expect(patchClashes(current, { emoteTrigger: 'meta' as never })).toBe(false);
  });
});

describe('mergeSettings', () => {
  it('applies a patch and re-normalizes it', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { volume: 500, tickSound: false });
    expect(s.volume).toBe(100);
    expect(s.tickSound).toBe(false);
    expect(s.trigger).toBe('alt');
  });
});

describe('rendererPatch', () => {
  it('leaves out the imported emotes, which change only by importing and removing', () => {
    const custom = [{ id: `c:${'ab'.repeat(16)}`, name: 'x', animated: false }];
    expect(rendererPatch({ volume: 3, customEmotes: custom })).toEqual({ volume: 3 });
    expect(rendererPatch({ customEmotes: [] })).toEqual({});
    expect(rendererPatch({ emoteWheel: [...DEFAULT_EMOTE_WHEEL] })).toEqual({ emoteWheel: [...DEFAULT_EMOTE_WHEEL] });
  });

  it('leaves out updateNotifiedVersion, which only the main process sets, but keeps autoUpdateCheck', () => {
    expect(rendererPatch({ volume: 3, updateNotifiedVersion: '9.9.9' })).toEqual({ volume: 3 });
    expect(rendererPatch({ updateNotifiedVersion: null })).toEqual({});
    expect(rendererPatch({ autoUpdateCheck: false })).toEqual({ autoUpdateCheck: false });
  });

  it('turns a patch that is not an object into no change', () => {
    for (const raw of [null, undefined, 'volume', 3, [1, 2]]) expect(rendererPatch(raw)).toEqual({});
  });
});

describe('helpers', () => {
  it('labels triggers', () => {
    expect(triggerLabel('alt')).toBe('Alt');
    expect(triggerLabel('capslock')).toBe('Caps Lock');
    expect(triggerLabel('mouse5')).toBe('Mouse 5');
    expect(triggerLabel({ vk: 0x56 })).toBe('V');
  });

  it('labels triggers with Mac names on macOS', () => {
    expect(triggerLabel('alt', 'en', 'mac')).toBe('⌥ Option');
    expect(triggerLabel('win', 'en', 'mac')).toBe('⌘ Command');
    expect(triggerLabel({ vk: 0x0d }, 'en', 'mac')).toBe('Return');
  });

  it('offers Caps Lock only on Windows, and replaces a stored one on macOS', () => {
    expect(keyboardTriggers('win')).toContain('capslock');
    expect(keyboardTriggers('mac')).not.toContain('capslock');
    expect(normalizeSettings({ trigger: 'capslock' }).trigger).toBe('capslock');
    expect(normalizeSettings({ trigger: 'capslock' }, 'mac').trigger).toBe('alt');
    expect(mergeSettings(DEFAULT_SETTINGS, { trigger: 'capslock' }, 'mac').trigger).toBe('alt');
    expect(normalizeSettings({ trigger: 'win' }, 'mac').trigger).toBe('win');
  });

  it('extracts overlay settings', () => {
    expect(overlaySettings(DEFAULT_SETTINGS)).toEqual({
      pingSizePx: 110, pingDurationS: 3.2, volume: 70, muted: false, tickSound: true,
      wheel: ['danger', 'push', 'omw', 'allin', 'assist', 'needvision', 'missing', 'enemyvision'], clickPingId: 'generic',
      emoteWheel: [...DEFAULT_EMOTE_WHEEL], clickEmoteId: DEFAULT_CLICK_EMOTE, emoteSizePx: 150, emoteSound: true, customEmotes: [],
    });
  });

  it('overlaySettings carries the emote fields', () => {
    const custom = [{ id: `c:${'a'.repeat(32)}`, name: 'Mine', animated: true }];
    const s = normalizeSettings({ customEmotes: custom, clickEmoteId: custom[0].id, emoteSizePx: 200, emoteSound: false });
    const o = overlaySettings(s);
    expect(o).toMatchObject({ clickEmoteId: custom[0].id, emoteSizePx: 200, emoteSound: false, customEmotes: custom });
    expect(o.emoteWheel).toEqual(s.emoteWheel);
    expect(o.emoteWheel).not.toBe(s.emoteWheel);
    expect(o.customEmotes).not.toBe(s.customEmotes);
  });
});

describe('update settings', () => {
  it('defaults: automatic checks on, nothing notified yet', () => {
    const s = normalizeSettings(undefined);
    expect([s.autoUpdateCheck, s.updateNotifiedVersion]).toEqual([true, null]);
    expect([DEFAULT_SETTINGS.autoUpdateCheck, DEFAULT_SETTINGS.updateNotifiedVersion]).toEqual([true, null]);
  });

  it('keeps autoUpdateCheck when it is a boolean and falls back to on otherwise', () => {
    expect(normalizeSettings({ autoUpdateCheck: false }).autoUpdateCheck).toBe(false);
    expect(normalizeSettings({ autoUpdateCheck: true }).autoUpdateCheck).toBe(true);
    for (const raw of [0, 'no', null, {}]) expect(normalizeSettings({ autoUpdateCheck: raw }).autoUpdateCheck).toBe(true);
  });

  it('updateNotifiedVersion is kept only as x.y.z', () => {
    expect(normalizeSettings({ updateNotifiedVersion: '0.5.1' }).updateNotifiedVersion).toBe('0.5.1');
    for (const raw of ['x', '', '0.5', 'v0.5.1', '0.5.1-beta', '0.5.1\n', ' 0.5.1', 5, {}, ['0.5.1'], undefined]) {
      expect(normalizeSettings({ updateNotifiedVersion: raw }).updateNotifiedVersion).toBeNull();
    }
  });

  it('merges a patch through the same rules', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { updateNotifiedVersion: '0.6.0', autoUpdateCheck: false });
    expect([s.autoUpdateCheck, s.updateNotifiedVersion]).toEqual([false, '0.6.0']);
    expect(mergeSettings(s, { updateNotifiedVersion: 'junk' }).updateNotifiedVersion).toBeNull();
  });
});
