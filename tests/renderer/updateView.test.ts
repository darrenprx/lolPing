import { describe, expect, it } from 'vitest';
import { strings } from '../../src/shared/i18n';
import { checkNote, formatCheckTime } from '../../src/renderer/settings/updateView';

const en = strings('en');
const time = (ms: number): string => `T${ms}`;

describe('checkNote', () => {
  it('says the version is current and when it was checked, once a check has finished', () => {
    expect(checkNote({ phase: 'idle', lastCheck: 5 }, en, time)).toBe('lolPing is up to date · Checked T5');
  });

  it('says nothing before the first finished check', () => {
    expect(checkNote({ phase: 'idle', lastCheck: null }, en, time)).toBeNull();
  });

  it('says nothing while the state is anything but idle', () => {
    expect(checkNote({ phase: 'checking', manual: true }, en, time)).toBeNull();
    expect(checkNote({ phase: 'available', version: '0.5.1', notesUrl: 'https://example.test' }, en, time)).toBeNull();
    expect(checkNote({ phase: 'downloading', version: '0.5.1', percent: 3 }, en, time)).toBeNull();
    expect(checkNote({ phase: 'installing', version: '0.5.1' }, en, time)).toBeNull();
    expect(checkNote({ phase: 'error', message: 'x', retry: 'check' }, en, time)).toBeNull();
  });

  it('is in the other language too', () => {
    const zh = strings('zh-CN');
    expect(checkNote({ phase: 'idle', lastCheck: 5 }, zh, time)).toBe(`${zh.upToDate} · ${zh.checkedAt('T5')}`);
  });
});

describe('formatCheckTime', () => {
  it('gives hours and minutes only', () => {
    expect(formatCheckTime(Date.UTC(2026, 9, 7, 12, 34, 56), 'en')).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/i);
  });
});
