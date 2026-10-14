/** Public connection state never contains the API key. */
export interface AiConnectionConfig {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  encryptionAvailable: boolean;
}
export interface AiConnectionPatch {
  endpoint: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
}
export type AiConfigResult = { ok: true; config: AiConnectionConfig } | { ok: false; error: 'invalid' | 'storage' };
