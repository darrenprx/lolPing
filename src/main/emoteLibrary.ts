import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUDIO_TYPES, sniffAudio } from '../shared/audioSniff';
import {
  ANIM_MAX_BYTES, ANIM_MAX_SIDE, CUSTOM_NAME_MAX, MAX_CUSTOM_EMOTES, SOUND_MAX_BYTES, STILL_MAX_BYTES, STILL_SIDE, customAnimUrl,
  customHash, customSoundUrl, customStillUrl, isBundledEmote, isCustomRef, type CustomEmote, type EmoteArt, type EmoteFile,
  type EmoteRef, type ImportError, type SoundError,
} from '../shared/emotes';
import { gifExtent, isAnimatedWebp, sniffImage, webpSize } from '../shared/imageSniff';
import { sanitizeName } from '../shared/roomProtocol';
import { isFile } from './fileState';
import { renameWithRetry } from './settingsStore';

const soundNames = (hash: string): string[] => AUDIO_TYPES.map((t) => `${hash}.sound.${t}`);

export type SaveResult = { ok: true; emote: CustomEmote } | { ok: false; error: ImportError };

const fail = (error: ImportError): SaveResult => ({ ok: false, error });
const longest = (size: { width: number; height: number }): number => Math.max(size.width, size.height);

/** An import as it arrived over IPC, rebuilt from its known fields: a string name and byte arrays. Null for anything else. */
export function emoteFileFrom(raw: unknown): EmoteFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { name, still, anim } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !(still instanceof Uint8Array)) return null;
  if (anim === undefined) return { name, still };
  return anim instanceof Uint8Array ? { name, still, anim } : null;
}

/** The still the settings window encoded: a still WebP of at most STILL_MAX_BYTES and STILL_SIDE px. */
export function checkStill(b: Uint8Array): ImportError | null {
  if (sniffImage(b) !== 'webp' || isAnimatedWebp(b)) return 'type'; // the still is served as an <img> on every overlay: it must not move
  if (b.length > STILL_MAX_BYTES) return 'size';
  const size = webpSize(b);
  return size && longest(size) <= STILL_SIDE ? null : 'type';
}

/** The original animation: a GIF or WebP, small enough to decode on every emote. */
function checkAnim(b: Uint8Array): ImportError | null {
  const type = sniffImage(b);
  if (type !== 'gif' && type !== 'webp') return 'type';
  if (b.length > ANIM_MAX_BYTES) return 'animSize';
  const size = type === 'gif' ? gifExtent(b) : webpSize(b);
  if (!size) return 'type';
  return longest(size) > ANIM_MAX_SIDE ? 'animSize' : null;
}

/** A sound for an imported emote: OGG, MP3 or WAV by its first bytes, at most SOUND_MAX_BYTES. Its length is checked when picked. */
export function checkSound(b: Uint8Array): SoundError | null {
  if (!sniffAudio(b)) return 'type';
  return b.length > SOUND_MAX_BYTES ? 'size' : null;
}

/**
 * What an emote looks like on screen. A room member's imported emote shows as its still when it is one of ours too, or,
 * through `cacheHas`, when its still arrived over the room. Anything else is the placeholder.
 */
export function resolveEmoteArt(ref: EmoteRef, custom: readonly CustomEmote[], remote: boolean, cacheHas: (hash: string) => boolean = () => false): EmoteArt {
  if (isBundledEmote(ref)) return { kind: 'bundled', slug: ref };
  if (!isCustomRef(ref)) return { kind: 'placeholder' };
  const hash = customHash(ref);
  const emote = custom.find((c) => c.id === ref);
  if (emote) {
    const animated = emote.animated && !remote;
    const sound = emote.sound && !remote ? { sound: customSoundUrl(hash) } : {};
    return { kind: 'custom', url: animated ? customAnimUrl(hash) : customStillUrl(hash), still: customStillUrl(hash), animated, ...sound, fx: emote.fx ?? 0 };
  }
  // A friend's cached still has no entry here, so the plain pop is its default; the sender's message can still carry their fx.
  return remote && cacheHas(hash) ? { kind: 'custom', url: customStillUrl(hash), still: customStillUrl(hash), animated: false, fx: 0 } : { kind: 'placeholder' };
}

/**
 * Imported emotes on disk: `<hash>.webp` (the still), `<hash>.anim.gif|webp` (the original animation) and
 * `<hash>.sound.ogg|mp3|wav` in `dir`.
 * Everything that arrives is checked again here, whatever the settings window already checked, and the id is computed here.
 */
export class EmoteLibrary {
  /** `dir` is <settings folder>/emotes. */
  constructor(readonly dir: string) {}

  async save(file: EmoteFile, existing: readonly CustomEmote[]): Promise<SaveResult> {
    const f = emoteFileFrom(file);
    if (!f) return fail('type');
    const error = checkStill(f.still) ?? (f.anim ? checkAnim(f.anim) : null);
    if (error) return fail(error);
    const hash = createHash('sha256').update(f.still).digest('hex').slice(0, 32);
    const id = `c:${hash}`;
    if (existing.some((c) => c.id === id)) return fail('duplicate');
    if (existing.length >= MAX_CUSTOM_EMOTES) return fail('full');

    const animName = f.anim ? `${hash}.anim.${sniffImage(f.anim)}` : null;
    const files = [{ name: `${hash}.webp`, data: f.still }, ...(f.anim && animName ? [{ name: animName, data: f.anim }] : [])];
    // Files left by an earlier copy of this image: an animation in the other format would be served instead of this one.
    const stale = [`${hash}.anim.gif`, `${hash}.anim.webp`].filter((n) => n !== animName);
    try {
      await this.write(files, stale);
    } catch (err) {
      console.warn('[emotes] import failed:', (err as Error).message);
      return fail('disk');
    }
    // A name with nothing left shows the first characters of its hash, as in normalizeSettings.
    const name = sanitizeName(f.name.slice(0, 256), hash.slice(0, 6), CUSTOM_NAME_MAX);
    return { ok: true, emote: { id, name, animated: f.anim !== undefined } };
  }

  /** Saves `sound` as the emote's sound, replacing any it had, or deletes its sound when `sound` is null. */
  async setSound(id: EmoteRef, sound: Uint8Array | null): Promise<SoundError | null> {
    if (!isCustomRef(id)) return 'type';
    const hash = customHash(id);
    const all = soundNames(hash);
    try {
      if (sound === null) {
        for (const n of all) await rm(join(this.dir, n), { force: true });
        return null;
      }
      const error = checkSound(sound);
      if (error) return error;
      const name = `${hash}.sound.${sniffAudio(sound)}`;
      await this.write([{ name, data: sound }], all.filter((n) => n !== name)); // a sound in another format would be served first
      return null;
    } catch (err) {
      console.warn('[emotes] could not save a sound:', (err as Error).message);
      return 'disk';
    }
  }

  /** Deletes an emote's files. Best effort: a file that can't be deleted is only an orphan, which a later import overwrites. */
  async remove(id: EmoteRef): Promise<void> {
    if (!isCustomRef(id)) return;
    const hash = customHash(id);
    await Promise.all([`${hash}.webp`, `${hash}.anim.gif`, `${hash}.anim.webp`, ...soundNames(hash)].map((n) =>
      rm(join(this.dir, n), { force: true }).catch((err: Error) => console.warn('[emotes] could not delete', n, err.message))));
  }

  /**
   * The entries whose still exists (run at launch, before anything reads them). When the folder can't be read at all (no
   * permission, say) nothing is known about its files, so the entries stay rather than the user's list being emptied.
   */
  present(list: readonly CustomEmote[]): CustomEmote[] {
    return list.filter((c) => isCustomRef(c.id) && isFile(join(this.dir, `${customHash(c.id)}.webp`), true));
  }

  /** Every file goes to a temp name first, then all are renamed. On any failure none of them is left behind. */
  private async write(files: readonly { name: string; data: Uint8Array }[], stale: readonly string[]): Promise<void> {
    const paths = files.map((f) => join(this.dir, f.name));
    const temps = paths.map((p) => `${p}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      for (const n of stale) await rm(join(this.dir, n), { force: true });
      for (let i = 0; i < files.length; i++) await writeFile(temps[i], files[i].data);
      for (let i = 0; i < files.length; i++) await renameWithRetry(temps[i], paths[i]);
    } catch (err) {
      await Promise.all([...temps, ...paths].map((p) => rm(p, { force: true }).catch(() => undefined)));
      throw err;
    }
  }
}
