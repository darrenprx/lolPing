import { describe, expect, it } from 'vitest';
import { strings } from '../../src/shared/i18n';
import { isNewer, isVersion, REASON_MAX_CHARS, shortReason, updateErrorText } from '../../src/shared/update';

describe('isNewer', () => {
  it('is true when the candidate is higher', () => {
    expect(isNewer('0.5.1', '0.5.0')).toBe(true);
    expect(isNewer('0.6.0', '0.5.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  });

  it('is false for the same or an older version', () => {
    expect(isNewer('0.5.0', '0.5.0')).toBe(false);
    expect(isNewer('0.4.9', '0.5.0')).toBe(false);
    expect(isNewer('0.5.0', '0.5.1')).toBe(false);
  });

  it('compares numbers, not text', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('0.5.10', '0.5.9')).toBe(true);
  });

  it('is false for anything that is not numeric x.y.z', () => {
    expect(isNewer('0.5.1-beta', '0.5.0')).toBe(false);
    expect(isNewer('v0.5.1', '0.5.0')).toBe(false);
    expect(isNewer('0.5', '0.5.0')).toBe(false);
    expect(isNewer('', '0.5.0')).toBe(false);
    expect(isNewer('0.5.1.2', '0.5.0')).toBe(false);
    expect(isNewer('0.5.1 ', '0.5.0')).toBe(false);
    expect(isNewer('0.5.1\n', '0.5.0')).toBe(false);
    expect(isNewer('0.5.1', 'dev')).toBe(false);
    expect(isNewer('0.5.1', '')).toBe(false);
  });

  it('is false for numbers too long to compare exactly', () => {
    expect(isNewer('99999999999999999999.0.0', '0.5.0')).toBe(false);
  });
});

describe('isVersion', () => {
  it('accepts numeric x.y.z only', () => {
    expect(isVersion('0.5.1')).toBe(true);
    expect(isVersion('10.20.30')).toBe(true);
    for (const v of ['', '0.5', 'v0.5.1', '0.5.1-beta', '0.5.1\n', 'x', 5, null, undefined, {}]) expect(isVersion(v)).toBe(false);
  });
});

describe('shortReason', () => {
  it('keeps a short one-line reason as it is', () => {
    expect(shortReason('net::ERR_CONNECTION_REFUSED')).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('keeps only the first line of a message with a stack', () => {
    const first = 'Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v1/latest.yml): HttpError: 404';
    const msg = `${first}\nHeaders: {\n  "server": "GitHub.com",\n  "content-type": "text/html"\n}\n    at GitHubProvider.getLatestVersion (app.asar/out/main/index.js:1:2)\n    at async x`;
    expect(shortReason(msg)).toBe(first);
  });

  it('skips empty and blank lines before the first text, and trims it', () => {
    expect(shortReason('\n  \r\n \t  socket hang up  \nat somewhere')).toBe('socket hang up');
    expect(shortReason('first\rsecond')).toBe('first');
  });

  it('cuts a long single line at the cap and says so with an ellipsis', () => {
    const long = `<html>${'x'.repeat(5000)}</html>`;
    const out = shortReason(long);
    expect(Array.from(out)).toHaveLength(REASON_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('<html>xxx')).toBe(true);
  });

  it('leaves a line of exactly the cap alone, and cuts one char more', () => {
    expect(shortReason('a'.repeat(REASON_MAX_CHARS))).toBe('a'.repeat(REASON_MAX_CHARS));
    expect(shortReason('a'.repeat(REASON_MAX_CHARS + 1))).toBe(`${'a'.repeat(REASON_MAX_CHARS - 1)}…`);
  });

  it('does not end on a space before the ellipsis, or split a character in two', () => {
    expect(shortReason(`${'a'.repeat(REASON_MAX_CHARS - 2)}   tail`)).toBe(`${'a'.repeat(REASON_MAX_CHARS - 2)}…`);
    const out = shortReason('😀'.repeat(REASON_MAX_CHARS + 5));
    expect(Array.from(out)).toHaveLength(REASON_MAX_CHARS);
    expect(out).toBe(`${'😀'.repeat(REASON_MAX_CHARS - 1)}…`);
  });

  it('gives an empty string for an empty or blank reason', () => {
    expect(shortReason('')).toBe('');
    expect(shortReason('   \n\t\r\n  ')).toBe('');
  });

  it('caps at about 150 characters', () => {
    expect(REASON_MAX_CHARS).toBe(150);
  });
});

describe('updateErrorText', () => {
  const en = strings('en');
  const zh = strings('zh-CN');

  it('shows the short form of a check reason, never the stack or the page', () => {
    const reason = 'Cannot check: HttpError: 403\nHeaders: {...}\n    at GitHubProvider (x.js:1:1)\n<html>captive portal</html>';
    expect(updateErrorText(en, 'check', reason)).toBe('Couldn’t check for updates: Cannot check: HttpError: 403');
  });

  it('shows the short form of a download reason after the plain text', () => {
    expect(updateErrorText(en, 'download', 'ENOSPC: no space left on device\n    at write')).toBe(
      'The download failed. Try again. (ENOSPC: no space left on device)',
    );
  });

  it('cuts a long reason in both kinds', () => {
    const long = 'y'.repeat(2000);
    for (const kind of ['check', 'download'] as const) {
      const text = updateErrorText(en, kind, long);
      expect(text.length).toBeLessThan(260);
      expect(text).toContain('y…');
    }
  });

  it('says something readable when there is no reason', () => {
    expect(updateErrorText(en, 'check', '')).toBe(`Couldn’t check for updates: ${en.updateReasonUnknown}`);
    expect(updateErrorText(en, 'download', '  \n ')).toBe(en.updateErrDownload);
    expect(updateErrorText(zh, 'check', '')).toBe(zh.updateErrCheck(zh.updateReasonUnknown));
  });

  it('shows the damaged and install messages as they are, whatever the reason', () => {
    expect(updateErrorText(en, 'damaged', 'sha512 checksum mismatch, expected a, got b\n    at x')).toBe(en.updateErrDamaged);
    expect(updateErrorText(en, 'install', 'spawn EACCES')).toBe(en.updateErrInstall);
  });

  it('follows the language', () => {
    expect(updateErrorText(zh, 'download', 'EACCES')).toBe(`${zh.updateErrDownload} (EACCES)`);
  });
});
