import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEmoteFile } from '../../src/main/appProtocol';
import { EmoteLibrary, emoteFileFrom, resolveEmoteArt } from '../../src/main/emoteLibrary';
import { customAnimUrl, customStillUrl, type CustomEmote, type EmoteFile } from '../../src/shared/emotes';

vi.mock('electron', () => ({ net: {}, protocol: {} }));

// statSync works as usual until a test sets `statError`, then fails with that error code (EPERM, EACCES...), which a real
// folder can't be made to do portably.
const statError = vi.hoisted(() => ({ code: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const statSync = ((path: unknown, options: unknown) => {
    if (statError.code) throw Object.assign(new Error(`${statError.code}: simulated, stat '${String(path)}'`), { code: statError.code });
    return (real.statSync as (...args: unknown[]) => unknown)(path, options);
  }) as typeof real.statSync;
  return { ...real, statSync };
});
afterEach(() => {
  statError.code = null;
  vi.restoreAllMocks();
});

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
/** The header bytes, then `fill` up to `total` bytes. */
const padded = (head: number[], total: number, fill = 7): Uint8Array => {
  const out = new Uint8Array(Math.max(total, head.length)).fill(fill);
  out.set(head);
  return out;
};

/** A lossy WebP still: only the headers are real, which is all the library reads. */
const still = (w = 160, h = 120, total = 600, fill = 7): Uint8Array =>
  padded([...ascii('RIFF'), ...le32(total - 8), ...ascii('WEBPVP8 '), ...le32(total - 20), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)], total, fill);
const gif = (w = 200, h = 200, total = 2000): Uint8Array => padded([...ascii('GIF89a'), ...le16(w), ...le16(h), 0xf7, 0, 0], total);
/** A GIF whose logical screen is sw x sh and whose one frame is fw x fh: a decoder draws the frame, even past the screen. */
const gifFrame = (sw: number, sh: number, fw: number, fh: number, total = 2000): Uint8Array =>
  padded([...ascii('GIF89a'), ...le16(sw), ...le16(sh), 0, 0, 0, 0x2c, 0, 0, 0, 0, ...le16(fw), ...le16(fh), 0, 2, 1, 7, 0, 0x3b], total, 0);
const webpAnim =(w = 200, h = 200, total = 2000): Uint8Array =>
  padded([...ascii('RIFF'), ...le32(total - 8), ...ascii('WEBPVP8X'), ...le32(10), 0x12, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)], total);
/** A still in the extended format, as the WebP encoder writes one with transparency: VP8X flags, then the canvas size. */
const stillExtended = (flags: number, w = 160, h = 120, total = 600): Uint8Array =>
  padded([...ascii('RIFF'), ...le32(total - 8), ...ascii('WEBPVP8X'), ...le32(10), flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)], total);
const png = (): Uint8Array => padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 300);
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
/** An APNG whose IHDR says 200 x 200: only the chunk layout is real, which is all the library reads. */
const apng = (): Uint8Array => {
  const chunk = (type: string, data: number[]): number[] => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(200), ...be32(200), 8, 6, 0, 0, 0]),
    ...chunk('acTL', [...be32(2), ...be32(0)]),
    ...chunk('fcTL', [...be32(0), ...be32(200), ...be32(200), ...be32(0), ...be32(0), ...be16(5), ...be16(100), 0, 0]),
    ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);
};
const ogg = (total = 500): Uint8Array => padded(ascii('OggS'), total);
const mp3 = (total = 500): Uint8Array => padded([...ascii('ID3'), 4, 0], total);

const hashOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'lolping-emotes-'));
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
const entry = (n: number): CustomEmote => ({ id: `c:${n.toString(16).padStart(32, '0')}`, name: `e${n}`, animated: false });

describe('EmoteLibrary', () => {
  it('saves a still and an animation', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const s = still();
    const a = gif();
    const result = await lib.save({ name: ' ​Party\u0007 cat with a very long name indeed ', still: s, anim: a }, []);
    const hash = hashOf(s);
    expect(result).toEqual({ ok: true, emote: { id: `c:${hash}`, name: 'Party cat with a very lo', animated: true } });
    expect(files(lib.dir)).toEqual([`${hash}.anim.gif`, `${hash}.webp`]);
    expect(readFileSync(join(lib.dir, `${hash}.webp`))).toEqual(Buffer.from(s));
    expect(readFileSync(join(lib.dir, `${hash}.anim.gif`))).toEqual(Buffer.from(a));
  });

  it('saves a still on its own, and a WebP animation as .anim.webp', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const plain = await lib.save({ name: 'plain', still: still(160, 160, 600, 1) }, []);
    expect(plain).toMatchObject({ ok: true, emote: { name: 'plain', animated: false } });
    const moving = await lib.save({ name: 'moving', still: still(160, 160, 600, 2), anim: webpAnim() }, []);
    expect(moving).toMatchObject({ ok: true, emote: { animated: true } });
    const h1 = hashOf(still(160, 160, 600, 1));
    const h2 = hashOf(still(160, 160, 600, 2));
    expect(files(lib.dir)).toEqual([`${h1}.webp`, `${h2}.anim.webp`, `${h2}.webp`].sort());
  });

  it('saves an APNG animation as .anim.png', async () => {
    const lib = new EmoteLibrary(tempDir());
    const result = await lib.save({ name: 'apng', still: still(160, 160, 600, 3), anim: apng() }, []);
    expect(result).toMatchObject({ ok: true, emote: { animated: true } });
    const hash = hashOf(still(160, 160, 600, 3));
    expect(files(lib.dir)).toEqual([`${hash}.anim.png`, `${hash}.webp`]);
  });

  it('accepts a static extended WebP as the still, such as one with transparency', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    for (const flags of [0x00, 0x10, 0x2c]) {
      const s = stillExtended(flags, 160, 120, 600 + flags);
      expect(await lib.save({ name: 'x', still: s }, []), String(flags)).toMatchObject({ ok: true, emote: { id: `c:${hashOf(s)}`, animated: false } });
    }
  });

  it('names an image whose name sanitises to nothing after its hash', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const s = still();
    expect(await lib.save({ name: '​​', still: s }, [])).toMatchObject({ ok: true, emote: { name: hashOf(s).slice(0, 6) } });
  });

  it('rejects bad input', async () => {
    const cases: Array<[string, EmoteFile, readonly CustomEmote[], string]> = [
      ['a still that is not WebP', { name: 'x', still: png() }, [], 'type'],
      ['a still over 12,288 bytes', { name: 'x', still: still(160, 160, 12_289) }, [], 'size'],
      ['a still wider than 160 px', { name: 'x', still: still(161, 100) }, [], 'type'],
      ['a still taller than 160 px', { name: 'x', still: still(100, 400) }, [], 'type'],
      ['an animated WebP as the still', { name: 'x', still: stillExtended(0x02) }, [], 'type'],
      ['an animated WebP with alpha as the still', { name: 'x', still: stillExtended(0x12) }, [], 'type'],
      ['an animation that is neither GIF, WebP nor an APNG', { name: 'x', still: still(), anim: png() }, [], 'type'],
      ['an animation over 5,242,880 bytes', { name: 'x', still: still(), anim: gif(200, 200, 5_242_881) }, [], 'animSize'],
      ['an empty animation', { name: 'x', still: still(), anim: new Uint8Array() }, [], 'type'],
      ['a payload that is not bytes', { name: 'x', still: [1, 2, 3] as unknown as Uint8Array }, [], 'type'],
      ['a name that is not a string', { name: 5 as unknown as string, still: still() }, [], 'type'],
      ['an image that is already imported', { name: 'x', still: still() }, [{ id: `c:${hashOf(still())}`, name: 'y', animated: false }], 'duplicate'],
      ['a 25th image', { name: 'x', still: still() }, Array.from({ length: 24 }, (_, i) => entry(i)), 'full'],
    ];
    for (const [label, file, existing, error] of cases) {
      const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
      expect(await lib.save(file, existing), label).toEqual({ ok: false, error });
      expect(files(lib.dir), label).toEqual([]);
    }
  });

  it('rejects an oversize animation', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    expect(await lib.save({ name: 'x', still: still(), anim: gif(4000, 4000) }, [])).toEqual({ ok: false, error: 'animSize' });
    expect(await lib.save({ name: 'x', still: still(), anim: webpAnim(1025, 10) }, [])).toEqual({ ok: false, error: 'animSize' });
    expect(files(lib.dir)).toEqual([]);
    expect(await lib.save({ name: 'x', still: still(), anim: gif(1024, 1024) }, [])).toMatchObject({ ok: true });
  });

  it('measures an animation by its frames, not only its logical screen', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    for (const anim of [gifFrame(1, 1, 1025, 10), gifFrame(1, 1, 9000, 9000), gifFrame(1, 1, 30000, 30000), gifFrame(100, 100, 100, 2000)]) {
      expect(await lib.save({ name: 'x', still: still(), anim }, [])).toEqual({ ok: false, error: 'animSize' });
    }
    expect(files(lib.dir)).toEqual([]);
    expect(await lib.save({ name: 'x', still: still(), anim: gifFrame(1, 1, 1024, 1024) }, [])).toMatchObject({ ok: true });
    expect(await lib.save({ name: 'y', still: still(100, 100), anim: gifFrame(0, 0, 64, 64) }, [])).toMatchObject({ ok: true }); // an empty screen
  });

  it('disk failure leaves nothing', async () => {
    const parent = tempDir();
    const dir = join(parent, 'emotes');
    writeFileSync(dir, 'not a folder');
    const lib = new EmoteLibrary(dir);
    expect(await lib.save({ name: 'x', still: still(), anim: gif() }, [])).toEqual({ ok: false, error: 'disk' });
    expect(files(parent)).toEqual(['emotes']);
  });

  it('removes a failed import’s first file when the second cannot be written', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const s = still();
    // A folder where the animation's temp file should go makes that write fail after the still's has succeeded.
    mkdirSync(join(lib.dir, `${hashOf(s)}.anim.gif.tmp`), { recursive: true });
    expect(await lib.save({ name: 'x', still: s, anim: gif() }, [])).toEqual({ ok: false, error: 'disk' });
    expect(files(lib.dir)).toEqual([`${hashOf(s)}.anim.gif.tmp`]); // only the obstacle is left
  });

  it('replaces a leftover animation in the other format', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const s = still();
    mkdirSync(lib.dir, { recursive: true });
    writeFileSync(join(lib.dir, `${hashOf(s)}.anim.gif`), 'stale'); // from an earlier copy that was not cleaned up
    expect(await lib.save({ name: 'x', still: s, anim: webpAnim() }, [])).toMatchObject({ ok: true });
    expect(files(lib.dir)).toEqual([`${hashOf(s)}.anim.webp`, `${hashOf(s)}.webp`]);
  });

  it('removes both files', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const s = still();
    const saved = await lib.save({ name: 'x', still: s, anim: gif() }, []);
    expect(saved.ok).toBe(true);
    const other = await lib.save({ name: 'y', still: still(100, 100) }, []);
    await lib.remove(`c:${hashOf(s)}`);
    expect(files(lib.dir)).toEqual([`${hashOf(still(100, 100))}.webp`]);
    expect(other.ok).toBe(true);
    await lib.remove('../settings'); // not an emote id: nothing happens
    await lib.remove(`c:${hashOf(s)}`); // already gone: fine
    expect(files(lib.dir)).toHaveLength(1);
  });

  it('saves a sound, replaces it in another format, and deletes it', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const s = still();
    const hash = hashOf(s);
    await lib.save({ name: 'x', still: s }, []);
    expect(await lib.setSound(`c:${hash}`, ogg())).toBeNull();
    expect(files(lib.dir)).toEqual([`${hash}.sound.ogg`, `${hash}.webp`]);
    expect(await lib.setSound(`c:${hash}`, mp3())).toBeNull(); // the OGG would be served first: it goes
    expect(files(lib.dir)).toEqual([`${hash}.sound.mp3`, `${hash}.webp`]);
    expect(await lib.setSound(`c:${hash}`, null)).toBeNull();
    expect(files(lib.dir)).toEqual([`${hash}.webp`]);
  });

  it('refuses a sound that is not OGG, MP3 or WAV, or is over 1 MB, and keeps the old one', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const hash = hashOf(still());
    await lib.save({ name: 'x', still: still() }, []);
    await lib.setSound(`c:${hash}`, ogg());
    expect(await lib.setSound(`c:${hash}`, png())).toBe('type');
    expect(await lib.setSound(`c:${hash}`, ogg(1_048_577))).toBe('size');
    expect(await lib.setSound('../settings', ogg())).toBe('type');
    expect(files(lib.dir)).toEqual([`${hash}.sound.ogg`, `${hash}.webp`]);
  });

  it('removes an emote together with its sound', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const id = `c:${hashOf(still())}`;
    await lib.save({ name: 'x', still: still() }, []);
    await lib.setSound(id, mp3());
    await lib.remove(id);
    expect(files(lib.dir)).toEqual([]);
  });

  it('present drops entries whose still is gone', async () => {
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const a = await lib.save({ name: 'a', still: still(100, 100), anim: gif() }, []);
    const b = await lib.save({ name: 'b', still: still(120, 100) }, []);
    if (!a.ok || !b.ok) throw new Error('save failed');
    rmSync(join(lib.dir, `${a.emote.id.slice(2)}.webp`)); // the animation alone doesn't keep it
    expect(lib.present([a.emote, b.emote, entry(1)])).toEqual([b.emote]);
    expect(new EmoteLibrary(join(tempDir(), 'missing')).present([b.emote])).toEqual([]);
  });
});

describe('emoteFileFrom', () => {
  it('accepts a name and bytes, building a fresh object', () => {
    const s = still();
    const a = gif();
    expect(emoteFileFrom({ name: 'x', still: s, anim: a, extra: 1 })).toEqual({ name: 'x', still: s, anim: a });
    expect(emoteFileFrom({ name: 'x', still: s })).toEqual({ name: 'x', still: s });
    expect(emoteFileFrom({ name: 'x', still: Buffer.from(s) })).not.toBeNull(); // a Buffer is a Uint8Array
  });

  it('refuses anything else', () => {
    for (const raw of [null, 'x', 5, [], { still: still() }, { name: 'x' }, { name: 'x', still: [1, 2] },
      { name: 'x', still: still(), anim: 'gif' }, { name: 'x', still: still(), anim: null }, { name: 'x', still: new ArrayBuffer(4) }]) {
      expect(emoteFileFrom(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('resolveEmoteArt', () => {
  const hash = 'ab'.repeat(16);
  const moving: CustomEmote = { id: `c:${hash}`, name: 'm', animated: true };
  const plain: CustomEmote = { id: `c:${'cd'.repeat(16)}`, name: 'p', animated: false };

  it('plays our own animation, but shows a room member’s emote as its still', () => {
    expect(resolveEmoteArt(moving.id, [moving], false)).toEqual({ kind: 'custom', url: `lolping://emotes/${hash}.anim`, still: `lolping://emotes/${hash}.webp`, animated: true, fx: 0 });
    expect(resolveEmoteArt(moving.id, [moving], true)).toEqual({ kind: 'custom', url: `lolping://emotes/${hash}.webp`, still: `lolping://emotes/${hash}.webp`, animated: false, fx: 0 });
    expect(resolveEmoteArt(plain.id, [plain], false)).toEqual({ kind: 'custom', url: `lolping://emotes/${'cd'.repeat(16)}.webp`, still: `lolping://emotes/${'cd'.repeat(16)}.webp`, animated: false, fx: 0 });
  });

  it('carries the stored effect through to the art', () => {
    const picked: CustomEmote = { id: `c:${hash}`, name: 'm', animated: false, fx: 5 };
    expect(resolveEmoteArt(picked.id, [picked], false)).toEqual({ kind: 'custom', url: `lolping://emotes/${hash}.webp`, still: `lolping://emotes/${hash}.webp`, animated: false, fx: 5 });
  });

  it('plays our own emote’s sound, never a room member’s', () => {
    const loud: CustomEmote = { ...plain, sound: true };
    const sound = `lolping://emotes/${'cd'.repeat(16)}.sound`;
    expect(resolveEmoteArt(loud.id, [loud], false)).toMatchObject({ kind: 'custom', sound });
    expect(resolveEmoteArt(loud.id, [loud], true)).not.toHaveProperty('sound');
    expect(resolveEmoteArt(plain.id, [plain], false)).not.toHaveProperty('sound');
  });

  it('resolves bundled emotes and stands a placeholder in for unknown ones', () => {
    expect(resolveEmoteArt('facepalm', [], true)).toEqual({ kind: 'bundled', slug: 'facepalm' });
    expect(resolveEmoteArt(moving.id, [plain], false)).toEqual({ kind: 'placeholder' });
    expect(resolveEmoteArt('not_an_emote', [], false)).toEqual({ kind: 'placeholder' });
  });
});

describe('resolveEmoteFile', () => {
  const hash = '0123456789abcdef'.repeat(2);
  const setup = (first: string[], second: string[]): [string, string] => {
    const a = tempDir();
    const b = tempDir();
    for (const f of first) writeFileSync(join(a, f), 'x');
    for (const f of second) writeFileSync(join(b, f), 'x');
    return [a, b];
  };

  it('finds a still in the first folder that has it', () => {
    const [a, b] = setup([], [`${hash}.webp`]);
    expect(resolveEmoteFile([a, b], `/${hash}.webp`)).toBe(join(b, `${hash}.webp`));
    const [c, d] = setup([`${hash}.webp`], [`${hash}.webp`]);
    expect(resolveEmoteFile([c, d], `/${hash}.webp`)).toBe(join(c, `${hash}.webp`));
    expect(resolveEmoteFile([a], `/${hash}.webp`)).toBeNull();
  });

  it('serves the animation as .anim.gif, then .anim.webp, then .anim.png, then the still', () => {
    const [a] = setup([`${hash}.anim.gif`, `${hash}.anim.webp`, `${hash}.anim.png`, `${hash}.webp`], []);
    expect(resolveEmoteFile([a], `/${hash}.anim`)).toBe(join(a, `${hash}.anim.gif`));
    const [b] = setup([`${hash}.anim.webp`, `${hash}.anim.png`, `${hash}.webp`], []);
    expect(resolveEmoteFile([b], `/${hash}.anim`)).toBe(join(b, `${hash}.anim.webp`));
    const [e] = setup([`${hash}.anim.png`, `${hash}.webp`], []);
    expect(resolveEmoteFile([e], `/${hash}.anim`)).toBe(join(e, `${hash}.anim.png`));
    const [c] = setup([`${hash}.webp`], []);
    expect(resolveEmoteFile([c], `/${hash}.anim`)).toBe(join(c, `${hash}.webp`)); // a missing animation shows as its still
    const [d] = setup([], []);
    expect(resolveEmoteFile([d], `/${hash}.anim`)).toBeNull();
  });

  it('serves a sound as .sound.ogg, .mp3 or .wav, and nothing in its place', () => {
    const [a] = setup([`${hash}.sound.mp3`, `${hash}.webp`], []);
    expect(resolveEmoteFile([a], `/${hash}.sound`)).toBe(join(a, `${hash}.sound.mp3`));
    const [b] = setup([`${hash}.webp`], []);
    expect(resolveEmoteFile([b], `/${hash}.sound`)).toBeNull();
    expect(resolveEmoteFile([a], `/${hash}.sound.mp3`)).toBeNull();
  });

  it('serves no other names', () => {
    const [a] = setup([`${hash}.webp`, `${hash}.anim.gif`, `${hash}.png`], []);
    writeFileSync(join(a, '..', 'x.webp'), 'x');
    for (const path of ['/../x.webp', `/${hash}.png`, `/${hash.toUpperCase()}.webp`, `/${hash}.anim.gif`, `/%2e%2e/x.webp`,
      `/${hash}.webp/`, `/sub/${hash}.webp`, `${hash}.webp`, `/${hash.slice(1)}.webp`, '/']) {
      expect(resolveEmoteFile([a], path), path).toBeNull();
    }
  });

  it('skips a folder entry that is not a file', () => {
    const [a, b] = setup([], [`${hash}.webp`]);
    mkdirSync(join(a, `${hash}.webp`));
    expect(resolveEmoteFile([a, b], `/${hash}.webp`)).toBe(join(b, `${hash}.webp`));
  });
});

describe('an emotes folder that can’t be read', () => {
  const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const hashes = [1, 2, 3].map((n) => n.toString(16).padStart(32, '0'));

  it('keeps every entry at launch and says so once', () => {
    const warn = warnings();
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const list = hashes.map((h, i) => ({ id: `c:${h}`, name: `e${i}`, animated: false }));
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      statError.code = code;
      expect(lib.present(list), code).toEqual(list); // the files may well be there: the user's list stays
    }
    expect(warn).toHaveBeenCalledTimes(3); // once for each error, not once for each entry or each launch step
    expect(warn.mock.calls[0].join(' ')).toContain('EPERM');
    statError.code = 'EPERM';
    lib.present(list);
    expect(warn).toHaveBeenCalledTimes(3); // already said for this folder
  });

  it('still drops entries whose still is plainly missing, without a warning', () => {
    const warn = warnings();
    const lib = new EmoteLibrary(join(tempDir(), 'emotes'));
    const list = [entry(1), entry(2)];
    for (const code of ['ENOENT', 'ENOTDIR']) {
      statError.code = code;
      expect(lib.present(list), code).toEqual([]);
    }
    statError.code = null;
    expect(lib.present(list)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('serves nothing from it, and says so once', () => {
    const warn = warnings();
    const hash = 'fedcba9876543210'.repeat(2);
    const dir = tempDir();
    writeFileSync(join(dir, `${hash}.webp`), 'x');
    statError.code = 'EACCES';
    expect(resolveEmoteFile([dir], `/${hash}.webp`)).toBeNull();
    expect(resolveEmoteFile([dir], `/${hash}.anim`)).toBeNull(); // three names tried, one report
    expect(warn).toHaveBeenCalledTimes(1);
    statError.code = null;
    expect(resolveEmoteFile([dir], `/${hash}.webp`)).toBe(join(dir, `${hash}.webp`)); // and again once it can be read
  });
});

describe('resolveEmoteArt with the cache', () => {
  const HASH = 'a'.repeat(32);

  it('shows a friend’s still from the cache, never the animation, at the plain pop', () => {
    expect(resolveEmoteArt(`c:${HASH}`, [], true, (h) => h === HASH)).toEqual({ kind: 'custom', url: customStillUrl(HASH), still: customStillUrl(HASH), animated: false, fx: 0 });
    expect(resolveEmoteArt(`c:${HASH}`, [], true, () => false)).toEqual({ kind: 'placeholder' });
  });

  it('never serves own emotes from the cache, and the library still wins with its animation and its effect', () => {
    const mine = [{ id: `c:${HASH}`, name: 'Mine', animated: true, fx: 5 }];
    expect(resolveEmoteArt(`c:${HASH}`, mine, false, () => true)).toEqual({ kind: 'custom', url: customAnimUrl(HASH), still: customStillUrl(HASH), animated: true, fx: 5 });
    expect(resolveEmoteArt(`c:${HASH}`, mine, true, () => true)).toEqual({ kind: 'custom', url: customStillUrl(HASH), still: customStillUrl(HASH), animated: false, fx: 5 });
  });

  it('keeps the placeholder for a malformed ref', () => {
    expect(resolveEmoteArt('nope', [], true, () => true)).toEqual({ kind: 'placeholder' });
  });
});
