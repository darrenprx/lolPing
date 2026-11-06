import { mountChat } from './chat';

const root = document.getElementById('chat');
if (root) mountChat(root, window.roomChatApi);
