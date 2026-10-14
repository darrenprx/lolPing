import { renderAnswerMarkdown } from './markdown';
import './style.css';
declare global {
  interface Window { aiAnswer: { ready(callback: (channel: string) => void): void; invoke(channel: string, action: 'get' | 'copy' | 'close'): Promise<string | undefined> } }
}
window.aiAnswer.ready(async (channel) => {
  document.querySelector('#answer')!.innerHTML = renderAnswerMarkdown(await window.aiAnswer.invoke(channel, 'get') ?? '暂无回答');
  document.querySelector('#copy')!.addEventListener('click', async () => {
    await window.aiAnswer.invoke(channel, 'copy');
    document.querySelector('#copy')!.textContent = '已复制';
  });
  document.querySelector('#close')!.addEventListener('click', () => void window.aiAnswer.invoke(channel, 'close'));
});
