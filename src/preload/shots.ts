import { contextBridge, ipcRenderer } from 'electron';
import type { ShotApi, ShotViewState } from '../shared/ipc';

const api: ShotApi = {
  on: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ShotViewState): void => cb(state);
    ipcRenderer.on('shot:state', listener);
    ipcRenderer.send('shot:ready');
    return () => ipcRenderer.removeListener('shot:state', listener);
  },
  act: (action) => ipcRenderer.send('shot:action', action),
};
contextBridge.exposeInMainWorld('shotApi', api);
