import { describe, expect, it, vi } from 'vitest';
import { APP_SCHEME, registerAppScheme } from '../../src/main/appProtocol';

const { registered } = vi.hoisted(() => ({ registered: [] as unknown[] }));

vi.mock('electron', () => ({
  net: {},
  protocol: { registerSchemesAsPrivileged: (schemes: unknown[]) => registered.push(...schemes) },
}));

describe('registerAppScheme', () => {
  it('lets the overlay fetch an imported emote sound from lolping://emotes, another origin', () => {
    registerAppScheme();
    expect(registered).toEqual([
      { scheme: APP_SCHEME, privileges: expect.objectContaining({ standard: true, supportFetchAPI: true, corsEnabled: true }) },
    ]);
  });
});
