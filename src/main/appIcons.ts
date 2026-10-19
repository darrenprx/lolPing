/** An app's icon as a PNG data URL, or null when the platform or the file has none. `readFileIcon` fails to null. */
export class AppIcons {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly readFileIcon: (path: string) => Promise<string | null>) {}

  /** One fetch per path, shared by every caller: an icon doesn't change while the app runs. */
  icon(path: string): Promise<string | null> {
    if (path === '') return Promise.resolve(null);
    let cached = this.cache.get(path);
    if (!cached) {
      cached = this.readFileIcon(path).catch(() => null);
      this.cache.set(path, cached);
    }
    return cached;
  }
}
