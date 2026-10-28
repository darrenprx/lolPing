import { appendFileSync, lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

let logFile = '';
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_SESSIONS = 10;

/** Only explicit technical events enter this log; never pass settings, packets, prompts or screenshots. */
export function redactDiagnostic(value: string): string {
  return value.split(homedir()).join('<home>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <redacted>')
    .replace(/(\b(?:api[_-]?key|token|password|authorization|secret)\b["'\s:=]+)([^\s,;"']+)/gi, '$1<redacted>')
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}/<redacted-path>`; }
      catch { return '<url>'; }
    }).slice(0, 8000);
}

export function diagnosticError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return { name: error.name, message: redactDiagnostic(error.message), stack: redactDiagnostic(error.stack ?? '') };
  }
  return { message: redactDiagnostic(String(error)) };
}

/** Failure to write diagnostics must never break the app or its input path. */
export function writeDiagnostic(event: string, details: object = {}): void {
  if (!logFile) return;
  try {
    if (lstatSync(logFile).size > MAX_BYTES) {
      try { unlinkSync(`${logFile}.1`); } catch { /* No previous segment. */ }
      renameSync(logFile, `${logFile}.1`);
    }
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...details }, (_key, value: unknown) =>
      typeof value === 'string' ? redactDiagnostic(value) : value);
    appendFileSync(logFile, `${line}\n`);
  } catch { /* A full or read-only disk must not interfere with input. */ }
}

export function diagnosticLogPath(): string { return logFile; }

export function setDiagnosticLog(file: string): void {
  logFile = file;
  if (!file) return;
  try {
    const dir = dirname(file);
    const sessions = readdirSync(dir).filter((name) => /^startup-\d+-\d+\.jsonl$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const name of sessions.slice(KEEP_SESSIONS)) {
      for (const entry of [join(dir, name), join(dir, `${name}.1`)]) {
        try {
          const info = lstatSync(entry);
          if (entry !== file && info.isFile() && !info.isSymbolicLink()) unlinkSync(entry);
        } catch { /* Already removed, locked, or not a file. */ }
      }
    }
  } catch { /* Retention is best effort. */ }
}
