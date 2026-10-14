import { BrowserWindow, clipboard, ipcMain } from 'electron';
import { loadPage, preloadPath } from './paths';

/** Each answer remains available until its window is explicitly closed. */
export function showAiAnswer(answer: string): BrowserWindow {
  const win = new BrowserWindow({
    title: 'AI 援助', width: 720, height: 620, minWidth: 420, minHeight: 320,
    alwaysOnTop: true, show: false,
    webPreferences: { preload: preloadPath('answer'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const channel = `ai-answer:${win.webContents.id}`;
  const allowed = (event: Electron.IpcMainInvokeEvent): boolean => event.sender === win.webContents && event.senderFrame?.routingId === win.webContents.mainFrame.routingId;
  ipcMain.handle(channel, (event, action: unknown) => {
    if (!allowed(event)) throw new Error('Unauthorized AI answer request');
    if (action === 'copy') clipboard.writeText(answer);
    else if (action === 'close') win.close();
    else if (action === 'get') return answer;
    return undefined;
  });
  win.on('closed', () => ipcMain.removeHandler(channel));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('ai-answer:channel', channel);
    win.show();
  });
  void loadPage(win, 'answer');
  return win;
}
