import { MOD, type Hotkey } from './keys';
import type { Settings } from './settings';

export const ROOM_CHAT_HOTKEY: Hotkey = { mods: MOD.ctrl | MOD.alt, vk: 0x54 };
export const ROOM_CHAT_ACCELERATOR = 'Control+Alt+T';

/** Existing user bindings win over the fixed chat shortcut, including a custom trigger that swallows T. */
export function roomChatShortcutFree(s: Settings): boolean {
  const same = (key: Hotkey): boolean => key.mods === ROOM_CHAT_HOTKEY.mods && key.vk === ROOM_CHAT_HOTKEY.vk;
  const triggerT = (key: Settings['emoteTrigger']): boolean => typeof key === 'object' && key.vk === ROOM_CHAT_HOTKEY.vk;
  return !same(s.toggleHotkey) && !same(s.textHotkey) && !triggerT(s.trigger)
    && !(s.features.emotes && triggerT(s.emoteTrigger))
    && !(s.features.teammate && triggerT(s.teammate.askTrigger === 'same' ? s.trigger : s.teammate.askTrigger));
}
