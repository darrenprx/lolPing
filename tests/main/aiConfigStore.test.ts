import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('electron', () => ({ safeStorage: {} }));
import { AiConfigStore } from '../../src/main/aiConfigStore';

const dirs: string[] = [];
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from([...value].reverse().join('')),
  decryptString: (value: Buffer) => [...value.toString()].reverse().join(''),
};
const make = (secure = crypto) => {
  const dir = mkdtempSync(join(tmpdir(), 'lolping-config-'));
  dirs.push(dir);
  return { dir, store: new AiConfigStore(dir, secure, {}) };
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('AI connection configuration', () => {
  it('keeps the app usable and disables AI when the saved file is damaged', () => {
    const { dir } = make();
    writeFileSync(join(dir, 'ai-config.json'), '{broken');
    const store = new AiConfigStore(dir, crypto, { AI_API_KEY: 'environment-key' });
    expect(store.publicConfig().hasApiKey).toBe(false);
    store.save({ endpoint: 'https://example.com/chat', model: 'test', apiKey: 'replacement-key' });
    expect(store.runtime().apiKey).toBe('replacement-key');
  });
  it('encrypts credentials, returns only status, and restores configuration after restart', () => {
    const { dir, store } = make();
    const state = store.save({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: 'private-test-key' });
    expect(state.hasApiKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain('private-test-key');
    expect(readFileSync(join(dir, 'ai-config.json'), 'utf8')).not.toContain('private-test-key');
    expect(statSync(join(dir, 'ai-config.json')).mode & 0o777).toBe(0o600);
    const restored = new AiConfigStore(dir, crypto, {});
    expect(restored.runtime().apiKey).toBe('private-test-key');
    restored.save({ endpoint: state.endpoint, model: 'another-model' });
    expect(restored.runtime().apiKey).toBe('private-test-key');
    restored.save({ endpoint: state.endpoint, model: state.model, clearApiKey: true });
    expect(restored.publicConfig().hasApiKey).toBe(false);
  });

  it('uses environment configuration initially and allows clearing its key', () => {
    const { dir } = make();
    const store = new AiConfigStore(dir, crypto, { AI_API_KEY: 'environment-key', AI_MODEL: 'custom-model', AI_CHAT_ENDPOINT: 'https://example.com/chat' });
    expect(store.runtime().apiKey).toBe('environment-key');
    store.save({ endpoint: 'https://example.com/chat', model: 'custom-model', clearApiKey: true });
    expect(new AiConfigStore(dir, crypto, { AI_API_KEY: 'environment-key' }).runtime().apiKey).toBe('');
  });

  it('rejects unsafe endpoints and refuses plaintext credential storage', () => {
    const { store } = make();
    for (const endpoint of ['http://example.com/chat', 'file:///tmp/image', 'https://user:password@example.com/chat']) {
      expect(() => store.save({ endpoint, model: 'test', apiKey: 'secret' })).toThrow();
    }
    expect(() => store.save({ endpoint: 'https://example.com/chat', model: '' })).toThrow();
    const unavailable = make({ ...crypto, isEncryptionAvailable: () => false }).store;
    expect(() => unavailable.save({ endpoint: 'https://example.com/chat', model: 'test', apiKey: 'secret' })).toThrow();
    expect(unavailable.publicConfig().hasApiKey).toBe(false);
  });
});
