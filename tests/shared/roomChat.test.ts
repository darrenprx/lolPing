import { describe, expect, it } from 'vitest';
import { ROOM_CHAT_HOTKEY, roomChatShortcutFree } from '../../src/shared/roomChat';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

describe('roomChatShortcutFree', () => {
  it('leaves the default room text and pause shortcuts unchanged', () => {
    expect(roomChatShortcutFree(DEFAULT_SETTINGS)).toBe(true);
  });

  it('gives an existing text or pause chord priority over chat', () => {
    expect(roomChatShortcutFree({ ...DEFAULT_SETTINGS, textHotkey: ROOM_CHAT_HOTKEY })).toBe(false);
    expect(roomChatShortcutFree({ ...DEFAULT_SETTINGS, toggleHotkey: ROOM_CHAT_HOTKEY })).toBe(false);
  });

  it('does not register over a custom T trigger that would swallow the chord', () => {
    expect(roomChatShortcutFree({ ...DEFAULT_SETTINGS, trigger: { vk: 0x54 } })).toBe(false);
    expect(roomChatShortcutFree({ ...DEFAULT_SETTINGS, emoteTrigger: { vk: 0x54 } })).toBe(false);
    expect(roomChatShortcutFree({
      ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features, teammate: true },
      teammate: { ...DEFAULT_SETTINGS.teammate, askTrigger: { vk: 0x54 } },
    })).toBe(false);
  });

  it('ignores a trigger belonging to a feature that is off', () => {
    expect(roomChatShortcutFree({
      ...DEFAULT_SETTINGS, emoteTrigger: { vk: 0x54 }, features: { ...DEFAULT_SETTINGS.features, emotes: false },
    })).toBe(true);
    expect(roomChatShortcutFree({
      ...DEFAULT_SETTINGS, teammate: { ...DEFAULT_SETTINGS.teammate, askTrigger: { vk: 0x54 } },
    })).toBe(true);
  });
});
