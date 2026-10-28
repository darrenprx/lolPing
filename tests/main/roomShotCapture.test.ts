import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { RoomShotCapture } from '../../src/main/roomShotCapture';
import type { ContextClient } from '../../src/main/teammate/contextClient';
import type { ShotCrop } from '../../src/main/roomShotController';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ toJPEG: () => jpeg }) } }));
const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 1, 104, 2, 128, 1, 1, 17, 0, 255, 217]);
let folder = '';
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'lolping-shot-test-')); });
afterEach(async () => {
  const target = resolve(folder), parent = resolve(tmpdir());
  if (!target.startsWith(`${parent}${sep}lolping-shot-test-`) || (await lstat(target)).isSymbolicLink()) throw new Error('bad cleanup root');
  await rm(target, { recursive: true, force: true });
});
function harness() {
  const root = join(folder, 'room-shot-temp');
  const front = vi.fn(async () => ({ window: 'w1', title: 'test', pid: 10, box: { x: 0, y: 0, w: 1920, h: 1080 } }));
  const capture = vi.fn<ContextClient['capture']>(async (req) => {
    const file = join(req.dir, 'overview-r1.jpg'); await writeFile(file, jpeg);
    return { overviewPath: file, overview: { w: 640, h: 360 }, zooms: [] };
  });
  const release = vi.fn(), exclude = vi.fn(() => release);
  const service = new RoomShotCapture({ front, capture }, root, exclude);
  const crop: ShotCrop = { source: { displayId: 1, number: 1, scale: 1.5,
    bounds: { x: -1920, y: 0, w: 1920, h: 1080 }, physical: { x: -2880, y: 0, w: 2880, h: 1620 } },
    rect: { x: 180, y: 220, w: 640, h: 360 }, marks: [{ x: 500, y: 400, n: 1 }] };
  return { root, front, capture, release, exclude, service, crop };
}

describe('RoomShotCapture', () => {
  it('maps a mixed-DPI negative-origin crop to physical coordinates and removes temporary JPEG files', async () => {
    const h = harness(); const image = await h.service.capture(h.crop, new AbortController().signal);
    expect(image).toMatchObject({ w: 640, h: 360 }); expect([...image.data]).toEqual([...jpeg]);
    expect(h.capture.mock.calls[0][0]).toMatchObject({ area: { x: -2610, y: 330, w: 960, h: 540 },
      display: { x: -2880, y: 0, w: 2880, h: 1620 }, spots: [], crops: [], overview: 960 });
    expect(h.release).toHaveBeenCalledTimes(1); expect(await readdir(h.root)).toEqual([]);
  });
  it('releases capture exclusion and cleans files after a native helper error, then recovers', async () => {
    const h = harness(); h.capture.mockRejectedValueOnce(new Error('capture permission'));
    await expect(h.service.capture(h.crop, new AbortController().signal)).rejects.toThrow('capture permission');
    expect(h.release).toHaveBeenCalledTimes(1); expect(await readdir(h.root)).toEqual([]);
    await expect(h.service.capture(h.crop, new AbortController().signal)).resolves.toMatchObject({ w: 640 });
    expect(h.release).toHaveBeenCalledTimes(2);
  });
  it('refuses a source window that changed while capturing instead of sharing an unrelated screen', async () => {
    const h = harness(); h.front.mockResolvedValueOnce({ window: 'first', title: 'test', pid: 10,
      box: { x: 0, y: 0, w: 1920, h: 1080 } });
    await expect(h.service.capture(h.crop, new AbortController().signal)).rejects.toThrow('source window changed');
    expect(await readdir(h.root)).toEqual([]); expect(h.release).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid JPEG headers and helper file paths outside the dedicated directory', async () => {
    const h = harness(); const outside = join(folder, 'original.txt'); await writeFile(outside, 'user data');
    h.capture.mockResolvedValueOnce({ overviewPath: outside, overview: { w: 640, h: 360 }, zooms: [] });
    await expect(h.service.capture(h.crop, new AbortController().signal)).rejects.toThrow('outside');
    expect(await readFile(outside, 'utf8')).toBe('user data');
    h.capture.mockImplementationOnce(async (req) => {
      const file = join(req.dir, 'overview-r2.jpg'); await writeFile(file, 'bad image');
      return { overviewPath: file, overview: { w: 640, h: 360 }, zooms: [] };
    });
    await expect(h.service.capture(h.crop, new AbortController().signal)).rejects.toThrow('invalid captured JPEG');
    expect(await readdir(h.root)).toEqual([]);
  });
  it('cleans only known feature artifacts and preserves unrelated files and reparse points', async () => {
    const h = harness(); const known = join(h.root, 'capture-old1'), user = join(h.root, 'business');
    await mkdir(known, { recursive: true }); await mkdir(user);
    await writeFile(join(known, 'overview-r1.jpg'), jpeg); await writeFile(join(known, 'notes.txt'), 'keep');
    await writeFile(join(user, 'original.txt'), 'keep');
    const link = join(h.root, 'capture-link1'); await symlink(user, link, 'junction');
    await h.service.clean();
    expect(await readFile(join(known, 'notes.txt'), 'utf8')).toBe('keep');
    expect(await readFile(join(user, 'original.txt'), 'utf8')).toBe('keep');
    expect(await lstat(link).then((s) => s.isSymbolicLink())).toBe(true);
    expect(await readdir(known)).toEqual(['notes.txt']);
  });
});
