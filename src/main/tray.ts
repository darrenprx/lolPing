import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { strings, type Strings } from '../shared/i18n';

export type TrayMode = 'on' | 'off' | 'failed';

export interface TrayHandlers {
  openSettings(): void;
  setEnabled(on: boolean): void;
  retryHelper(): void;
  quit(): void;
}

/** Re-colours a premultiplied BGRA bitmap pixel by pixel. */
function recolor(base: NativeImage, fn: (r: number, g: number, b: number, a: number) => [number, number, number, number]): NativeImage {
  const { width, height } = base.getSize();
  const bmp = Buffer.from(base.toBitmap());
  for (let i = 0; i < bmp.length; i += 4) {
    const [r, g, b, a] = fn(bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]);
    bmp[i] = b;
    bmp[i + 1] = g;
    bmp[i + 2] = r;
    bmp[i + 3] = a;
  }
  return nativeImage.createFromBitmap(bmp, { width, height });
}

export class AppTray {
  private readonly tray: Tray;
  private readonly icons: Record<TrayMode, NativeImage>;
  private mode: TrayMode = 'on';
  private enabled = true;
  private destroyed = false;

  constructor(
    iconPath: string,
    private readonly handlers: TrayHandlers,
    private text: Strings = strings('en'),
  ) {
    const size = 32;
    const base = nativeImage.createFromPath(iconPath).resize({ width: size, height: size, quality: 'best' });
    // solid orange silhouette = warning
    const failed = recolor(base, (_r, _g, _b, a) => [a, Math.round(a * 0.55), Math.round(a * 0.15), a]);
    this.icons = {
      on: base,
      // grey and half transparent (scale every channel: the bitmap is premultiplied)
      off: recolor(base, (r, g, b, a) => {
        const l = Math.round((0.3 * r + 0.59 * g + 0.11 * b) * 0.5);
        return [l, l, l, Math.round(a * 0.5)];
      }),
      failed,
    };
    this.tray = new Tray(this.icons.on);
    this.tray.on('click', () => handlers.openSettings());
    this.render();
  }

  /** A no-op once destroyed: helper events can still arrive while the app is quitting. */
  set(mode: TrayMode, enabled: boolean): void {
    if (this.destroyed) return;
    this.mode = mode;
    this.enabled = enabled;
    this.render();
  }

  /** Switches the tooltip and menu to another language. */
  setText(text: Strings): void {
    if (this.destroyed) return;
    this.text = text;
    this.render();
  }

  /** Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tray.destroy();
  }

  private render(): void {
    const failed = this.mode === 'failed';
    this.tray.setImage(this.icons[this.mode]);
    const t = this.text;
    this.tray.setToolTip(failed ? t.trayTipFailed : t.trayTip(this.enabled));
    const items: MenuItemConstructorOptions[] = [
      {
        label: t.trayEnabled, type: 'checkbox', checked: this.enabled, enabled: !failed,
        click: (item) => this.handlers.setEnabled(item.checked),
      },
    ];
    if (failed) items.push({ label: t.trayRestart, click: () => this.handlers.retryHelper() });
    items.push(
      { type: 'separator' },
      { label: t.traySettings, click: () => this.handlers.openSettings() },
      { label: t.trayQuit, click: () => this.handlers.quit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }
}
