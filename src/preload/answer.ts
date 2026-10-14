import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('aiAnswer', {
  ready: (callback: (channel: string) => void) => {
    ipcRenderer.once('ai-answer:channel', (_event, channel: string) => callback(channel));
  },
  invoke: (channel: string, action: 'get' | 'copy' | 'close') => {
    if (!/^ai-answer:\d+$/.test(channel)) return Promise.reject(new Error('Invalid answer channel'));
    return ipcRenderer.invoke(channel, action) as Promise<string | undefined>;
  },
});
