import { describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';
import { AiAssist, buildVisionRequest, focusCropRect } from '../../src/main/aiAssist';

describe('ai assistance', () => {
  it('uses changed connection settings immediately and stops requests after clearing the key', async () => {
    let config = { apiKey: 'first-key', endpoint: 'https://first.example/chat', model: 'first-model' };
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), { status: 200 }));
    const ai = new AiAssist({ getConfig: () => config, fetch: request, cooldownMs: 0 });
    const image = { toPNG: () => Buffer.from('test-image') } as NativeImage;
    await ai.explain(image, 'test');
    config = { apiKey: 'replacement-key', endpoint: 'https://second.example/chat', model: 'second-model' };
    await ai.explain(image, 'test');
    expect(request.mock.calls[1][0]).toBe(config.endpoint);
    expect(request.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer replacement-key' });
    expect(JSON.parse(request.mock.calls[1][1]?.body as string).model).toBe('second-model');
    config = { ...config, apiKey: '' };
    expect(ai.configured).toBe(false);
    expect(await ai.explain(image, 'test')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('uses a configured chat endpoint and extracts the vision answer', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '  这是一个错误提示  ' } }] }), { status: 200 }));
    const ai = new AiAssist({ apiKey: 'test-key', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions', fetch: request });
    const image = { toPNG: () => Buffer.from('test-image') } as NativeImage;
    expect(await ai.explain(image, '解释附近的内容')).toBe('这是一个错误提示');
    expect(request.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    const options = request.mock.calls[0][1]!;
    expect(JSON.parse(options.body as string).messages[0].content[1].image_url.url).toBe('data:image/png;base64,dGVzdC1pbWFnZQ==');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(await ai.explain(image, '再次解释')).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
  it('keeps the screenshot crop inside the display', () => {
    expect(focusCropRect({ width: 1920, height: 1080 }, { x: 20, y: 30 }, 640, 480)).toEqual({
      x: 0, y: 0, width: 640, height: 480,
    });
    expect(focusCropRect({ width: 1920, height: 1080 }, { x: 1900, y: 1060 }, 640, 480)).toEqual({
      x: 1280, y: 600, width: 640, height: 480,
    });
  });

  it('builds a vision request that tells the model to focus near the marker', () => {
    const request = buildVisionRequest('data:image/png;base64,abc', 'gpt-4.1-mini', '请解释这个界面');
    expect(request.model).toBe('gpt-4.1-mini');
    expect(request.messages[0].content[1].type).toBe('image_url');
    expect(request.messages[0].content[1].image_url.url).toBe('data:image/png;base64,abc');
    expect(request.messages[0].content[0].text).toContain('请解释这个界面');
    expect(request.messages[0].content[0].text).toContain('80%');
    expect(request.messages[0].content[0].text).toContain('20%');
  });

  it('sends local detail first and a separately labelled full-screen context second', () => {
    const request = buildVisionRequest('local', 'vision', '解释错误', { imageUrl: 'screen', marker: { x: 20, y: 30 } });
    const content = request.messages[0].content;
    expect(content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url)).toEqual(['local', 'screen']);
    expect(content[0].text).toContain('(20, 30)');
    expect(JSON.stringify(content)).toContain('整体');
  });
});
