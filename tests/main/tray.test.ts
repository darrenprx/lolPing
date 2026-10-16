import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Electron Tray that throws like the real one once destroyed.
const { FakeTray, created } = vi.hoisted(() => {
  const created: FakeTray[] = [];
  class FakeTray {
    destroyed = false;
    destroyCalls = 0;
    images: unknown[] = [];
    events: string[] = [];
    menus: unknown[] = [];
    constructor(image: unknown) {
      this.images.push(image);
      created.push(this);
    }
    private alive(): void {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
    }
    on(event: string): void {
      this.alive();
      this.events.push(event);
    }
    setImage(image: unknown): void {
      this.alive();
      this.images.push(image);
    }
    setToolTip(): void {
      this.alive();
    }
    setContextMenu(menu: unknown): void {
      this.alive();
      this.menus.push(menu);
    }
    destroy(): void {
      this.destroyCalls += 1;
      this.alive();
      this.destroyed = true;
    }
  }
  return { FakeTray, created };
});

const fakeImage = (): { template: boolean; [k: string]: unknown } => ({
  template: false,
  getSize: () => ({ width: 1, height: 1 }),
  toBitmap: () => Buffer.alloc(4),
  resize: () => fakeImage(),
  setTemplateImage(on: boolean) {
    this.template = on;
  },
});

vi.mock('electron', () => ({
  Tray: FakeTray,
  Menu: { buildFromTemplate: (items: unknown) => items },
  nativeImage: { createFromPath: () => fakeImage(), createFromBitmap: () => fakeImage() },
}));

import { AppTray } from '../../src/main/tray';

const handlers = { openSettings: vi.fn(), setEnabled: vi.fn(), retryHelper: vi.fn(), quit: vi.fn() };

beforeEach(() => {
  created.length = 0;
});

describe('AppTray', () => {
  it('renders mode changes while alive', () => {
    const tray = new AppTray('icon.png', handlers);
    const before = created[0].images.length;
    tray.set('off', false);
    expect(created[0].images.length).toBe(before + 1);
  });

  it('ignores set() after destroy() instead of touching the destroyed Tray', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.destroy();
    expect(() => tray.set('failed', false)).not.toThrow();
    expect(() => tray.set('on', true)).not.toThrow();
  });

  it('destroys the underlying Tray once, however often destroy() is called', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.destroy();
    expect(() => tray.destroy()).not.toThrow();
    expect(created[0].destroyCalls).toBe(1);
  });
});
