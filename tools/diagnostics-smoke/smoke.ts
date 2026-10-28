import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { install, failStartup, startupComplete } from '../../src/main/startupDiagnostics';
import { writeDiagnostic } from '../../src/main/diagnostics';
import { InputBridge } from '../../src/main/inputBridge';
import { RestartPolicy } from '../../src/main/restartPolicy';

const output = process.argv[2], mode = process.argv[3];
app.setPath('userData', join(output, `profile-${mode}`));
app.disableHardwareAcceleration();
const log = join(output, `${mode}.jsonl`);
writeFileSync(log, '');
install(log);
app.on('window-all-closed', () => undefined);
void app.whenReady().then(async () => {
  if (mode === 'fatal') { failStartup(new Error('synthetic startup initialization failure')); return; }
  const bad = new BrowserWindow({ show: false, webPreferences: { preload: join(output, 'missing-preload.cjs') } });
  await bad.loadFile(join(output, 'missing-page.html')).catch(() => undefined);
  bad.destroy();
  const good = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await good.loadURL('data:text/html,<h1>diagnostic recovery fixture</h1>');
  startupComplete();
  const gone = once(good.webContents, 'render-process-gone');
  good.webContents.forcefullyCrashRenderer();
  await gone;
  await good.loadURL('data:text/html,<h1>renderer recovered</h1>');
  const bridge = new InputBridge({ command: join(output, 'missing-helper.exe'), policy: new RestartPolicy([0], 1) });
  const failed = new Promise<void>((resolve) => bridge.on('status', (status: string) => {
    if (status === 'failed') { writeDiagnostic('input-helper-status-test', { status }); resolve(); }
  }));
  bridge.start();
  await failed;
  await bridge.stop();
  good.destroy();
  app.quit();
}).catch(failStartup);
