import type { RoomChatApi } from '../../shared/ipc';

declare global {
  interface Window {
    roomChatApi: RoomChatApi;
  }
}

export {};
