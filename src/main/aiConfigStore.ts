import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiConnectionConfig } from '../shared/aiConfig';

interface CryptoStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface StoredConfig { endpoint: string; model: string; encryptedKey: string }

export class AiConfigStore {
  private stored: StoredConfig | null = null;
  private readonly file: string;
  constructor(private readonly dir: string, private readonly crypto: CryptoStorage = safeStorage, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.file = join(dir, 'ai-config.json');
    if (existsSync(this.file)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!raw || typeof raw !== 'object') throw new Error('invalid');
        const r = raw as StoredConfig;
        validate(r.endpoint, r.model);
        if (typeof r.encryptedKey !== 'string') throw new Error('invalid');
        this.stored = { endpoint: r.endpoint, model: r.model, encryptedKey: r.encryptedKey };
      } catch {
        // A damaged file must not prevent settings from opening or silently enable an environment credential.
        this.stored = { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', encryptedKey: '' };
      }
    }
  }
  runtime(): { endpoint: string; model: string; apiKey: string } {
    if (!this.stored) return {
      endpoint: this.env.AI_CHAT_ENDPOINT || `${(this.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')}/v1/chat/completions`,
      model: this.env.AI_MODEL || 'deepseek-flash',
      apiKey: this.env.AI_API_KEY || this.env.OPENAI_API_KEY || '',
    };
    const { endpoint, model, encryptedKey } = this.stored;
    let apiKey = '';
    if (encryptedKey) {
      try { apiKey = this.crypto.decryptString(Buffer.from(encryptedKey, 'base64')); } catch { /* Ask the user to replace an unreadable credential. */ }
    }
    return { endpoint, model, apiKey };
  }
  publicConfig(): AiConnectionConfig {
    const { endpoint, model, apiKey } = this.runtime();
    return { endpoint, model, hasApiKey: Boolean(apiKey), encryptionAvailable: this.crypto.isEncryptionAvailable() };
  }
  save(raw: unknown): AiConnectionConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid');
    const p = raw as Record<string, unknown>;
    validate(p.endpoint, p.model);
    if (p.apiKey !== undefined && (typeof p.apiKey !== 'string' || p.apiKey.length > 4096 || /[\r\n]/.test(p.apiKey))) throw new Error('invalid');
    if (p.clearApiKey !== undefined && typeof p.clearApiKey !== 'boolean') throw new Error('invalid');
    const apiKey = p.clearApiKey ? '' : typeof p.apiKey === 'string' && p.apiKey.trim() ? p.apiKey.trim() : this.runtime().apiKey;
    if (apiKey && !this.crypto.isEncryptionAvailable()) throw new Error('storage');
    const next: StoredConfig = {
      endpoint: (p.endpoint as string).trim(), model: (p.model as string).trim(),
      encryptedKey: apiKey ? this.crypto.encryptString(apiKey).toString('base64') : '',
    };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    this.stored = next;
    return this.publicConfig();
  }
}

function validate(endpoint: unknown, model: unknown): void {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof model !== 'string' || !model.trim() || model.length > 200) throw new Error('invalid');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid');
}
