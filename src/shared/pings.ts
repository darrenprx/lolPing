export type PingId =
  | 'danger' | 'push' | 'omw' | 'allin' | 'assist' | 'needvision' | 'missing' | 'enemyvision' | 'generic'
  | 'bait' | 'visioncleared' | 'missingflip';

export interface PingDef {
  id: PingId;
  name: string;
  /** Texture on the wheel slice: file in assets/textures without ".png". */
  icon: string;
  /** Textures drawn at the ping location. Two entries = All In's clashing halves. */
  art: string[];
  /** File in assets/sounds without ".wav". */
  sound: string;
  /** Ring and glow colour. */
  color: string;
}

/** Every ping, in the order the settings window lists them: the default wheel, then the extras. */
export const ALL_PINGS: readonly PingDef[] = [
  { id: 'danger', name: 'Danger', icon: 'pingwheel_retreatrender', art: ['pingwheel_retreatrender'], sound: 'SRP_12', color: '#ff3b55' },
  { id: 'push', name: 'Push', icon: 'pingwheel_pushrender', art: ['pingwheel_pushrender'], sound: 'SRP_9', color: '#35d27a' },
  { id: 'omw', name: 'On My Way', icon: 'omw', art: ['omw'], sound: 'OnMyWay', color: '#2e8bff' },
  { id: 'allin', name: 'All In', icon: 'png_all_in', art: ['pingwheel_allin_render_01', 'pingwheel_allin_render_02'], sound: 'SRP_4', color: '#f2b320' },
  { id: 'assist', name: 'Assist Me', icon: 'png_assist_me_128x128', art: ['png_assist_me_128x128'], sound: 'ComeHere', color: '#35d27a' },
  { id: 'needvision', name: 'Need Vision', icon: 'mt11_18_vision', art: ['mt11_18_vision'], sound: 'SRP_7', color: '#35d27a' },
  { id: 'missing', name: 'Enemy Missing', icon: 'png_enemymissing_128x128', art: ['png_enemymissing_128x128'], sound: 'MIA', color: '#f2c518' },
  { id: 'enemyvision', name: 'Enemy Vision', icon: 'pingwheel_enemyvisionrender', art: ['pingwheel_enemyvisionrender'], sound: 'AreaIsWarded', color: '#ff3b55' },
  { id: 'generic', name: 'Generic', icon: 'pingwheel_basicpingrender', art: ['pingwheel_basicpingrender'], sound: 'Base', color: '#2e8bff' },
  { id: 'bait', name: 'Bait', icon: 'pingwheel_baitrender', art: ['pingwheel_baitrender'], sound: 'SRP_11', color: '#efbc12' },
  { id: 'visioncleared', name: 'Vision Cleared', icon: 'pingwheel_visionclearedrender', art: ['pingwheel_visionclearedrender'], sound: 'SRP_6', color: '#2b80ff' },
  // Not a League ping: Enemy Missing turned upside down ("¿"), asked for in #24. Older room peers drop it.
  { id: 'missingflip', name: 'Upside-down Missing', icon: 'enemy_missing_flipped', art: ['enemy_missing_flipped'], sound: 'MIA', color: '#f2c518' },
];

/** The wheel as League ships it, top (N) then clockwise. Array index = slice index from pickSlice(). */
export const DEFAULT_WHEEL: readonly PingId[] = ['danger', 'push', 'omw', 'allin', 'assist', 'needvision', 'missing', 'enemyvision'];
export const DEFAULT_CLICK_PING: PingId = 'generic';
export const WHEEL_SLOTS = 8;

export const TICK_SOUND = 'button';
export const FALLBACK_TEXTURE = 'pingwheel_basicpingrender';
/** lolPing's own icon (window, tray, toasts, settings). Not a ping, but it must survive the build's asset pruning. */
export const LOGO_TEXTURE = 'generic_ping';

export function pingById(id: string): PingDef | undefined {
  return ALL_PINGS.find((p) => p.id === id);
}

export const isPingId = (v: unknown): v is PingId => typeof v === 'string' && pingById(v) !== undefined;

/** Looks up ids already known to be valid (from normalized settings). */
export const pingsFor = (ids: readonly PingId[]): PingDef[] => ids.map((id) => pingById(id) as PingDef);

export const DEFAULT_WHEEL_PINGS: readonly PingDef[] = pingsFor(DEFAULT_WHEEL);

/** Relative to a renderer page at <root>/<page>/index.html; assets/ is served at <root>/. */
export const textureUrl = (name: string): string => `../textures/${name}.png`;
export const soundUrl = (name: string): string => `../sounds/${name}.wav`;

export function allSoundNames(): string[] {
  return [...new Set([...ALL_PINGS.map((p) => p.sound), TICK_SOUND])];
}

export function allTextureNames(): string[] {
  return [...new Set([...ALL_PINGS.flatMap((p) => [p.icon, ...p.art]), FALLBACK_TEXTURE, LOGO_TEXTURE])];
}
