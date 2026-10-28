import { app, dialog } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';
import { resolveLang, startupFailureText } from '../shared/i18n';
import { diagnosticError, diagnosticLogPath, setDiagnosticLog, writeDiagnostic } from './diagnostics';

let failed = false;
let started = false;

export function failStartup(error: unknown): void {
  writeDiagnostic('startup-failed', diagnosticError(error));
  if (failed) return;
  failed = true;
  const locale = app.isReady() ? app.getLocale() : Intl.DateTimeFormat().resolvedOptions().locale;
  const words = startupFailureText[resolveLang('auto', locale)];
  if (app.isPackaged || process.env.LOLPING_HIDDEN_TEST !== '1') {
    dialog.showErrorBox(words.title, `${words.message}\n${diagnosticLogPath()}`);
  }
  // Exiting also closes helper stdin, releasing every input hook.
  writeDiagnostic('forced-exit', { code: 1 });
  app.exit(1);
}

export function startupComplete(): void {
  started = true;
  writeDiagnostic('startup-complete');
}

/** Installed by the small bootstrap before loading any application modules. */
export function install(file: string): void {
  setDiagnosticLog(file);
  writeDiagnostic('runtime', { version: app.getVersion(), os: release(), arch: process.arch,
    packaged: app.isPackaged, gpuDisabled: app.commandLine.hasSwitch('disable-gpu') });
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
    if (metadata && typeof metadata === 'object' && 'localBuild' in metadata && typeof metadata.localBuild === 'string') {
      writeDiagnostic('local-build', { build: metadata.localBuild });
    }
  } catch { /* Loose native test entries have no package metadata. */ }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const resources = ['app.asar', `hook-helper${suffix}`,
    ...(process.platform === 'linux' ? [] : [`context-helper${suffix}`])];
  for (const name of resources) {
    const target = join(process.resourcesPath, name);
    try {
      writeDiagnostic('resource', { name, exists: existsSync(target),
        bytes: existsSync(target) ? statSync(target).size : 0 });
    } catch (error) { writeDiagnostic('resource-check-failed', { name, ...diagnosticError(error) }); }
  }
  process.on('uncaughtException', failStartup);
  process.on('unhandledRejection', (error: unknown) => {
    if (!started) failStartup(error);
    else writeDiagnostic('unhandled-rejection', diagnosticError(error));
  });
  app.on('browser-window-created', (_event, win) => {
    const id = win.id;
    writeDiagnostic('window-created', { id });
    win.on('ready-to-show', () => writeDiagnostic('window-ready', { id }));
    win.on('show', () => writeDiagnostic('window-shown', { id }));
    win.on('unresponsive', () => writeDiagnostic('window-unresponsive', { id }));
    win.on('closed', () => writeDiagnostic('window-closed', { id }));
  });
  app.on('web-contents-created', (_event, contents) => {
    const id = contents.id;
    contents.on('did-finish-load', () => writeDiagnostic('page-loaded', { id }));
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) =>
      writeDiagnostic('page-failed', { id, code, description, mainFrame }));
    contents.on('preload-error', (_event, _path, error) =>
      writeDiagnostic('preload-failed', { id, ...diagnosticError(error) }));
    contents.on('render-process-gone', (_event, details) =>
      writeDiagnostic('renderer-gone', { id, reason: details.reason, exitCode: details.exitCode }));
  });
  app.on('child-process-gone', (_event, details) => writeDiagnostic('child-gone', {
    type: details.type, reason: details.reason, exitCode: details.exitCode,
  }));
  app.on('before-quit', () => writeDiagnostic('before-quit'));
  app.on('will-quit', () => writeDiagnostic('will-quit'));
  process.on('exit', (code) => writeDiagnostic('process-exit', { code }));
}
