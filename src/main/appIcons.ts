/**
 * An app's icon as a PNG data URL, or null when there is none worth showing: the platform read nothing, or the
 * file only carries a copy of the shell's default program icon (an exe built without an icon embeds one anyway).
 * `defaultPath` names a file that has no icon of its own, fetched once as that reference.
 */
export class AppIcons {
  private readonly cache = new Map<string, Promise<string | null>>();
  private readonly defaultIcon: Promise<string | null>;

  constructor(private readonly readFileIcon: (path: string) => Promise<string | null>, defaultPath?: string) {
    this.defaultIcon = defaultPath ? this.fetch(defaultPath) : Promise.resolve(null);
  }

  /** One fetch per path, shared by every caller: an icon doesn't change while the app runs. */
  icon(path: string): Promise<string | null> {
    if (path === '') return Promise.resolve(null);
    let cached = this.cache.get(path);
    if (!cached) {
      cached = this.read(path);
      this.cache.set(path, cached);
    }
    return cached;
  }

  private async read(path: string): Promise<string | null> {
    const [icon, fallback] = await Promise.all([this.fetch(path), this.defaultIcon]);
    return icon !== null && icon !== fallback ? icon : null;
  }

  private fetch(path: string): Promise<string | null> {
    return this.readFileIcon(path).catch(() => null);
  }
}
