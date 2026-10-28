import { nativeImage } from 'electron';
import { mkdir, mkdtemp, readFile, readdir, lstat, rm, rmdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { SHOT_MAX_BYTES } from '../shared/roomShots';
import type { ShotCrop } from './roomShotController';
import type { ContextClient } from './teammate/contextClient';
import { jpegSize } from '../shared/jpegSize';

/** The native helper is reused independently of the AI teammate. Only the crop leaves this process. */
export class RoomShotCapture {
  constructor(readonly context: Pick<ContextClient, 'front' | 'capture'>, private readonly root: string,
    private readonly exclude: () => () => void) {}

  async capture(crop: ShotCrop, signal: AbortSignal): Promise<{ data: Uint8Array; w: number; h: number }> {
    const { source, rect } = crop;
    const area = { x: Math.round(source.physical.x + rect.x * source.scale),
      y: Math.round(source.physical.y + rect.y * source.scale),
      w: Math.round(rect.w * source.scale), h: Math.round(rect.h * source.scale) };
    if (area.w * area.h > 32_000_000) throw new Error('capture area too large');
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('capture directory is a link');
    const dir = await mkdtemp(join(this.root, 'capture-'));
    let release: (() => void) | null = null;
    try {
      release = this.exclude();
      const before = await this.context.front(signal);
      const cap = await this.context.capture({ display: source.physical, area, spots: [], crops: [], dir,
        overview: Math.max(64, Math.min(8192, Math.max(area.w, area.h))) }, signal);
      const after = await this.context.front(signal);
      if (signal.aborted || before.window !== after.window || before.title !== after.title
        || JSON.stringify(before.box) !== JSON.stringify(after.box)) throw new Error('source window changed');
      if (!resolve(cap.overviewPath).startsWith(`${resolve(dir)}${sep}`)) throw new Error('capture path is outside its directory');
      const raw = await readFile(cap.overviewPath);
      const size = jpegSize(raw);
      if (!size || size.w !== cap.overview.w || size.h !== cap.overview.h) throw new Error('invalid captured JPEG');
      let data: Uint8Array = raw;
      if (raw.length > SHOT_MAX_BYTES) data = nativeImage.createFromBuffer(raw).toJPEG(65);
      return { data, w: cap.overview.w, h: cap.overview.h };
    } finally {
      release?.();
      await this.remove(dir);
    }
  }

  /** Startup/exit cleanup touches only this feature's known capture directories, never junctions or user files. */
  async clean(): Promise<void> {
    if ((await lstat(this.root).catch(() => null))?.isSymbolicLink()) return;
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory() && /^capture-[A-Za-z0-9]+$/.test(e.name)) await this.remove(join(this.root, e.name));
  }

  private async remove(dir: string): Promise<void> {
    const root = resolve(this.root), target = resolve(dir);
    if (!target.startsWith(`${root}${sep}`)) return;
    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
    // Only direct files the helper created are removed; unexpected nested directories are preserved.
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isDirectory() || e.isSymbolicLink())) return;
    for (const e of entries) if (/^(overview|zoom)-r\d+(?:-\d+)?\.jpg$/.test(e.name))
      await rm(join(target, e.name), { force: true }).catch(() => undefined);
    await rmdir(target).catch(() => undefined);
  }
}
