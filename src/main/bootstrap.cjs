// Keep this entry free of application imports: a broken bundle must still leave a startup record.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, dialog } = require('electron');
const text = __BOOTSTRAP_TEXT__;
let file = '';
for (const root of [process.env.LOCALAPPDATA || os.tmpdir(), os.tmpdir()]) {
  try {
    const dir = path.join(root, 'lolPing', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `startup-${Date.now()}-${process.pid}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), event: 'bootstrap',
      platform: process.platform, arch: process.arch, os: os.release(), versions: process.versions }) + '\n');
    break;
  } catch { file = ''; }
}
let diagnostics;
try {
  if (process.platform === 'win32' && app.isPackaged) {
    const { execFileSync } = require('node:child_process');
    const output = execFileSync(path.join(process.resourcesPath, 'context-helper.exe'), ['--ensure-install-access'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 262144 });
    const access = JSON.parse(output);
    try { fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), event: 'install-access', ...access }) + '\n'); }
    catch {}
    if (!['unchanged', 'repaired'].includes(access.status) || access.code !== 0) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      throw new Error((/^zh/i.test(locale) ? text.zh.permission : text.en.permission) + ' (' + access.code + ')');
    }
  }
  diagnostics = require('./startupDiagnostics.js');
  diagnostics.install(file);
  require('./index.js');
} catch (error) {
  if (diagnostics) diagnostics.failStartup(error);
  else {
    try { fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), event: 'bootstrap-failed',
      code: error && error.code, name: error && error.name,
      message: String(error && error.message).slice(0, 2000) }) + '\n'); } catch {}
    const locale = app.isReady() ? app.getLocale() : Intl.DateTimeFormat().resolvedOptions().locale;
    const words = /^zh/i.test(locale) ? text.zh : text.en;
    dialog.showErrorBox(words.title, words.message + '\n' + String(error && error.message).slice(0, 1000) + '\n' + file);
    app.exit(1);
  }
}
