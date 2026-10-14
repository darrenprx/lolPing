import { describe, expect, it } from 'vitest';
import { AI_TEST_PNG, answerText, chatCompletion, imageMessage, recognizeImage, textMessage, trimMessages, type AiVisionResult } from '../../src/main/aiVision';

const cfg = { baseUrl: 'https://ai.test', apiKey: 'sk-test', model: 'vision-1', timeoutMs: 1000 };

const reasonOf = (r: AiVisionResult): string => (r.ok ? 'unexpected ok' : r.reason);

/** A fetch stub that answers every call with `status` and `body`, recording the requests. */
function fetchStub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const io = {
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch,
  };
  return { io, calls };
}

const ONE_BY_ONE = { width: 1, height: 1 };

describe('recognizeImage', () => {
  it('posts the image as a data URL to the chat completions endpoint and returns the answer', async () => {
    const { io, calls } = fetchStub(200, { choices: [{ message: { content: '这是一只猫。' } }] });
    const r = await recognizeImage(cfg, AI_TEST_PNG, io);
    expect(r).toEqual({ ok: true, text: '这是一只猫。' });
    expect(calls[0].url).toBe('https://ai.test/chat/completions');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.model).toBe('vision-1');
    const image = sent.messages[0].content.find((p: { type: string }) => p.type === 'image_url');
    expect(image.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer sk-test' });
  });

  it('refuses to send anything without a key', async () => {
    const { io, calls } = fetchStub(200, { choices: [] });
    const r = await recognizeImage({ ...cfg, apiKey: '  ' }, AI_TEST_PNG, io);
    expect(r).toEqual({ ok: false, reason: 'noKey', detail: 'no api key' });
    expect(calls).toEqual([]);
  });

  it('sorts a rejected key, rate limiting and an unknown model into their reasons', async () => {
    for (const status of [401, 403]) {
      const { io } = fetchStub(status, 'denied');
      expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, io))).toBe('auth');
    }
    const { io: busy } = fetchStub(429, 'slow down');
    expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, busy))).toBe('busy');
    const { io: missing } = fetchStub(404, 'Model `vision-1` does not exist');
    expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, missing))).toBe('model');
    const { io: bad } = fetchStub(400, 'Model Not Exist');
    expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, bad))).toBe('model');
    const { io: other } = fetchStub(400, 'bad request');
    expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, other))).toBe('unknown');
    const { io: down } = fetchStub(500, 'boom');
    expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, down))).toBe('unknown');
  });

  it('calls a refused connection a network failure', async () => {
    const io = { fetch: (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch };
    expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, io))).toBe('network');
  });

  it('times out a slow service', async () => {
    const io = {
      fetch: ((_url: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch,
    };
    expect(reasonOf(await recognizeImage({ ...cfg, timeoutMs: 10 }, AI_TEST_PNG, io))).toBe('timeout');
  });

  it('rejects a response without a readable answer', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: { content: '' } }] }, { choices: [{ message: { content: 42 } }] }]) {
      const { io } = fetchStub(200, body);
      expect(reasonOf(await recognizeImage(cfg, AI_TEST_PNG, io))).toBe('response');
    }
  });

  it('reads an answer spread across content parts', async () => {
    const { io } = fetchStub(200, { choices: [{ message: { content: [{ type: 'text', text: '第一段。' }, { type: 'text', text: '第二段。' }] } }] });
    expect(await recognizeImage(cfg, AI_TEST_PNG, io)).toEqual({ ok: true, text: '第一段。第二段。' });
  });
});

describe('answerText', () => {
  it('reads the content of the first choice, or nothing', () => {
    expect(answerText({ choices: [{ message: { content: ' hi ' } }] })).toBe('hi');
    expect(answerText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab');
    expect(answerText({ choices: [] })).toBeNull();
    expect(answerText({ choices: [{ message: { content: '  ' } }] })).toBeNull();
    expect(answerText('x')).toBeNull();
  });
});

describe('multi-turn messages', () => {
  it('sends the conversation as given, user and assistant turns in order', async () => {
    const { io, calls } = fetchStub(200, { choices: [{ message: { content: '好的。' } }] });
    const messages = [
      imageMessage('看这张图', AI_TEST_PNG, 'image/jpeg'),
      textMessage('assistant', '图里是一像素。'),
      textMessage('user', '左上角是什么颜色?'),
    ];
    const r = await chatCompletion(cfg, messages, io);
    expect(r).toEqual({ ok: true, text: '好的。' });
    expect(calls[0].url).toBe('https://ai.test/chat/completions');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.messages).toHaveLength(3);
    expect(sent.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(sent.messages[2]).toEqual({ role: 'user', content: '左上角是什么颜色?' });
  });

  it('keeps the image message and the newest turns when trimming', () => {
    const first = imageMessage('看这张图', AI_TEST_PNG);
    const rest = Array.from({ length: 30 }, (_, i) => textMessage(i % 2 ? 'assistant' : 'user', `t${i}`));
    const trimmed = trimMessages([first, ...rest], 20);
    expect(trimmed).toHaveLength(20);
    expect(trimmed[0]).toBe(first);
    expect(trimmed[19]).toEqual(rest[29]);
  });

  it('returns the messages unchanged when they already fit', () => {
    const messages = [imageMessage('p', AI_TEST_PNG), textMessage('assistant', 'a')];
    expect(trimMessages(messages)).toEqual(messages);
  });
});
