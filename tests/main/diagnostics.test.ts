import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnosticError, redactDiagnostic, setDiagnosticLog, writeDiagnostic } from '../../src/main/diagnostics';

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lolping-diagnostics-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  setDiagnosticLog('');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('diagnostics', () => {
  it('records structured failures and redacts credentials, home and URL paths', () => {
    const file = join(fixture(), 'startup-1-1.jsonl');
    writeFileSync(file, '');
    setDiagnosticLog(file);
    writeDiagnostic('failure', diagnosticError(new Error(
      `token=private123 ${homedir()} https://user:secret@example.com/private?api_key=sensitive`)));
    const text = readFileSync(file, 'utf8');
    expect(JSON.parse(text).event).toBe('failure');
    expect(text).not.toMatch(/private123|sensitive|user:secret/);
    expect(text).toContain('example.com');
    expect(text).toContain('<home>');
    expect(redactDiagnostic('Authorization: Bearer abc123')).not.toContain('abc123');
  });

  it('bounds a session log and keeps the previous segment', () => {
    const file = join(fixture(), 'startup-1-1.jsonl');
    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
    setDiagnosticLog(file);
    writeDiagnostic('after-rotation');
    expect(JSON.parse(readFileSync(file, 'utf8')).event).toBe('after-rotation');
    expect(readFileSync(`${file}.1`, 'utf8')).toHaveLength(2 * 1024 * 1024 + 1);
  });

  it('retains ten sessions and leaves unrelated files untouched', () => {
    const dir = fixture();
    for (let n = 1; n <= 15; n++) writeFileSync(join(dir, `startup-${n}-1.jsonl`), '');
    writeFileSync(join(dir, 'settings.json'), 'protected');
    setDiagnosticLog(join(dir, 'startup-15-1.jsonl'));
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toHaveLength(10);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('protected');
  });

  it('never throws when the log destination disappears or is not a file', () => {
    const dir = fixture();
    setDiagnosticLog(join(dir, 'missing', 'unwritable.jsonl'));
    expect(() => writeDiagnostic('missing')).not.toThrow();
    setDiagnosticLog(dir);
    expect(() => writeDiagnostic('directory')).not.toThrow();
    expect(diagnosticError({ reason: 'unknown' }).message).toBe('[object Object]');
  });
});
