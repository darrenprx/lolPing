import { contextBridge, ipcRenderer } from 'electron';
import type { RoomChatApi, RoomChatState } from '../shared/ipc';

const api: RoomChatApi = {
  // Inlined: sandboxed preloads cannot require a generated sibling chunk.
  get: () => ipcRenderer.invoke('chat:get'),
  on: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: RoomChatState): void => cb(state);
    ipcRenderer.on('chat:state', listener);
    return () => ipcRenderer.removeListener('chat:state', listener);
  },
  submit: (text) => ipcRenderer.invoke('chat:submit', text),
  draft: (text) => ipcRenderer.send('chat:draft', text),
  hide: () => ipcRenderer.send('chat:hide'),
};

contextBridge.exposeInMainWorld('roomChatApi', api);
