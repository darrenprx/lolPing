import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { startupFailureText } from '../../src/shared/i18n';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('startup bootstrap', () => {
  it.each(['repaired', 'failed'])('runs the install permission preflight before loading main: %s', (status) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lolping-bootstrap-test-'));
    roots.push(root);
    const loaded: string[] = [], exits: number[] = [];
    const source = readFileSync(path.resolve('src/main/bootstrap.cjs'), 'utf8')
      .replace('__BOOTSTRAP_TEXT__', JSON.stringify({ en: startupFailureText.en, zh: startupFailureText['zh-CN'] }));
    runInNewContext(source, {
      process: { env: { LOCALAPPDATA: root }, pid: 11, platform: 'win32', arch: 'x64', versions: {}, resourcesPath: root },
      require: (name: string): unknown => {
        if (name === 'node:fs') return fs;
        if (name === 'node:path') return path;
        if (name === 'node:os') return os;
        if (name === 'electron') return { app: { isPackaged: true, isReady: () => false,
          exit: (code: number) => exits.push(code) }, dialog: { showErrorBox: () => undefined } };
        if (name === 'node:child_process') return { execFileSync: () => {
          loaded.push('permission-check'); return JSON.stringify({ status, code: status === 'failed' ? 5 : 0 });
        } };
        if (name === './startupDiagnostics.js') return { install: () => loaded.push('diagnostics') };
        loaded.push('main'); return {};
      },
    });
    expect(loaded).toEqual(status === 'failed' ? ['permission-check'] : ['permission-check', 'diagnostics', 'main']);
    expect(exits).toEqual(status === 'failed' ? [1] : []);
    const dir = path.join(root, 'lolPing', 'logs');
    expect(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8')).toContain('install-access');
  });

  it('leaves a log and displays an error even when the diagnostic bundle cannot load', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lolping-bootstrap-test-'));
    roots.push(root);
    const exits: number[] = [];
    const dialogs: string[] = [];
    const source = readFileSync(path.resolve('src/main/bootstrap.cjs'), 'utf8')
      .replace('__BOOTSTRAP_TEXT__', JSON.stringify({ en: startupFailureText.en, zh: startupFailureText['zh-CN'] }));
    runInNewContext(source, {
      process: { env: { LOCALAPPDATA: root }, pid: 10, platform: 'win32', arch: 'x64', versions: { electron: '44' } },
      require: (name: string): unknown => {
        if (name === 'node:fs') return fs;
        if (name === 'node:path') return path;
        if (name === 'node:os') return os;
        if (name === 'electron') return { app: { isReady: () => false, getLocale: () => 'zh-CN',
          exit: (code: number) => exits.push(code) },
          dialog: { showErrorBox: (_title: string, message: string) => dialogs.push(message) } };
        throw new Error('missing startup bundle');
      },
    });
    const dir = path.join(root, 'lolPing', 'logs');
    const text = readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8');
    expect(text).toContain('bootstrap-failed');
    expect(text).toContain('missing startup bundle');
    expect(exits).toEqual([1]);
    expect(dialogs[0]).toContain('Diagnostic-Start.cmd');
  });
});
