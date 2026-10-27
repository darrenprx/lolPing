import type { MediaApi } from '../../shared/roomMedia';
import { RoomMediaEngine } from './engine';

declare global { interface Window { roomMedia: MediaApi } }
const engine = new RoomMediaEngine(window.roomMedia);
const off = window.roomMedia.on((command) => engine.command(command));
window.addEventListener('unload', () => { off(); engine.stop(); });
window.roomMedia.emit({ t: 'ready' });
