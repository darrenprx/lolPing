import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { MEDIA_CH, type MediaApi, type MediaCommand } from '../shared/roomMedia';

const api: MediaApi = {
  on: (cb) => {
    const listener = (_event: IpcRendererEvent, command: MediaCommand) => cb(command);
    ipcRenderer.on(MEDIA_CH.command, listener);
    return () => ipcRenderer.removeListener(MEDIA_CH.command, listener);
  },
  emit: (event) => ipcRenderer.send(MEDIA_CH.event, event),
};
contextBridge.exposeInMainWorld('roomMedia', api);
