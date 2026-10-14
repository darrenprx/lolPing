import { aiChatCompletionsUrl } from '../shared/settings';
import type { Strings } from '../shared/i18n';

export interface AiVisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Milliseconds before the request is abandoned. */
  timeoutMs: number;
}

export type AiVisionReason = 'noKey' | 'network' | 'auth' | 'model' | 'busy' | 'response' | 'timeout' | 'unknown';
export type AiVisionResult = { ok: true; text: string } | { ok: false; reason: AiVisionReason; detail: string };

export const AI_TIMEOUT_MS = 90_000;

/** What the shot is asked for. Neutral: identify and explain the picture, nothing about games. */
export const AI_PROMPT = '请识别并解释这张截图的内容。';

/** A conversation keeps at most this many messages: the first (with the image) plus the newest turns. */
const MAX_MESSAGES = 20;

/** One message of an OpenAI-compatible chat; `content` is a string or, for images, an array of parts. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

/** The first message of a conversation: the prompt and the captured image. */
export function imageMessage(prompt: string, image: Buffer, mime = 'image/jpeg'): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
    ],
  };
}

export const textMessage = (role: ChatMessage['role'], text: string): ChatMessage => ({ role, content: text });

/** Keeps the first message (it carries the image) plus the newest turns, so follow-ups stay in budget. */
export function trimMessages(messages: readonly ChatMessage[], max = MAX_MESSAGES): ChatMessage[] {
  if (messages.length <= max) return [...messages];
  return [messages[0], ...messages.slice(messages.length - (max - 1))];
}

/** A one-pixel PNG, just enough to learn whether the service accepts image input at all (the settings page's test). */
export const AI_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Sends one conversation to an OpenAI-compatible vision model and returns the last answer. The network comes in
 * through `io.fetch`, so tests run it against a stub. Errors are sorted into reasons the UI can name, with the
 * service's own text as detail.
 */
export async function chatCompletion(cfg: AiVisionConfig, messages: readonly ChatMessage[], io: { fetch: typeof fetch }): Promise<AiVisionResult> {
  const key = cfg.apiKey.trim();
  if (key === '') return { ok: false, reason: 'noKey', detail: 'no api key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await io.fetch(aiChatCompletionsUrl(cfg.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: 2048, temperature: 0.2 }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', detail: await detail(res) };
    if (res.status === 429) return { ok: false, reason: 'busy', detail: await detail(res) };
    if (res.status === 400 || res.status === 404) {
      // A wrong path and an unknown model both land here; the body usually says "model", so let it pick the message.
      const d = await detail(res);
      return /model/i.test(d) ? { ok: false, reason: 'model', detail: d } : { ok: false, reason: 'unknown', detail: d };
    }
    if (!res.ok) return { ok: false, reason: 'unknown', detail: await detail(res) };
    const answer = answerText(await res.json());
    return answer === null ? { ok: false, reason: 'response', detail: 'unreadable answer' } : { ok: true, text: answer };
  } catch (e) {
    return ctrl.signal.aborted
      ? { ok: false, reason: 'timeout', detail: 'timed out' }
      : { ok: false, reason: 'network', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The answer text of an OpenAI-compatible chat completion: `message.content` as a string or as text parts. */
export function answerText(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('')
      : '';
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** The user-facing line for a failed request, in the app's current language. */
export function aiErrorText(t: Strings, failed: { reason: AiVisionReason; detail: string }, model: string): string {
  switch (failed.reason) {
    case 'noKey': return t.aiToastNoKey;
    case 'network': return t.aiErrNetwork;
    case 'auth': return t.aiErrAuth;
    case 'model': return t.aiErrModel(model);
    case 'busy': return t.aiErrBusy;
    case 'response': return t.aiErrResponse;
    case 'timeout': return t.aiErrTimeout;
    default: return t.aiErrUnknown(failed.detail);
  }
}

/** The first lines of a service error body, for logs and the unknown-error message. */
async function detail(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/** One-shot helper: ask about a single image (the settings page's connection test). */
export function recognizeImage(cfg: AiVisionConfig, image: Buffer, io: { fetch: typeof fetch }, prompt: string = AI_PROMPT): Promise<AiVisionResult> {
  return chatCompletion(cfg, [imageMessage(prompt, image, 'image/png')], io);
}
