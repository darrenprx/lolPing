import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Point } from '../../shared/ipc';
import type { Rect, Shot } from '../../shared/teammate/coords';
import type { FrontWindow } from '../../shared/teammate/stale';
import {
  captureCommand, parseContextLine, pasteCommand, readCommand, serializeContextCommand, setFieldCommand,
  type ContextCommand, type ContextErrorCode, type ContextReply, type PasteRequest, type PasteResult, type ReadResult,
  type SetFieldRequest, type SetFieldResult,
} from '../../shared/teammate/contextProtocol';

/** A paste's own reply time: the helper's 3 s hands-off wait, the 1 s before the restore, and a margin. */
export const PASTE_TIMEOUT_MS = 6000;

/** `timeout`: no reply in time (the helper was restarted); `exited`: it died or never started; `stopped`: stop() ran. */
export type ContextFailure = ContextErrorCode | 'timeout' | 'aborted' | 'exited' | 'stopped';

export class ContextError extends Error {
  constructor(readonly code: ContextFailure, message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

/** The one `spawn` signature this client uses, so tests can start a fake helper. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ContextClientOptions {
  command: string;
  spawn?: SpawnFn;
  /** A request without a reply in this time restarts the helper (spec §6.2). */
  timeoutMs?: number;
}

export interface Capture {
  overviewPath: string;
  overview: Shot['overview'];
  zooms: { path: string; rect: Shot['zooms'][number] }[];
}

interface Pending {
  expect: ContextReply['type'];
  resolve: (r: ContextReply) => void;
  reject: (e: ContextError) => void;
}

/**
 * Runs context-helper, started on the first request, and matches its replies to requests by id.
 * A request that gets no reply in `timeoutMs` rejects with `timeout` and the helper is restarted.
 */
export class ContextClient {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private readonly timeoutMs: number;
  /** Ids of the pastes the helper is running, until their reply or the helper's end. */
  private readonly pastes = new Set<string>();
  /** Ids sent to the helper and not yet answered, aborted ones too: the helper still runs them, in order. */
  private readonly unanswered = new Set<string>();

  constructor(private readonly opts: ContextClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async capture(
    req: { display: Rect; area?: Rect; spots: { x: number; y: number }[]; crops?: Rect[]; dir: string; overview?: number },
    signal: AbortSignal,
  ): Promise<Capture> {
    const r = await this.request((id) => captureCommand(id, req), 'captured', signal);
    if (r.type !== 'captured') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { overviewPath: r.overview, overview: { w: r.ow, h: r.oh }, zooms: r.zooms };
  }

  /**
   * The context layers that are on, read side by side: the boxes around the element under each spot, the controls
   * and text near the spots (into a marks file in `dir`), the system text, the file behind the window and the form
   * fields (into a fields file in `dir`). A layer that was too slow comes back `slow`.
   */
  async read(
    req: {
      spots: Point[]; radius: number; marks: boolean; text: boolean; file: boolean; boxes: boolean; fields: boolean;
      dir: string;
    },
    signal: AbortSignal,
  ): Promise<ReadResult> {
    const r = await this.request((id) => readCommand(id, req), 'read', signal);
    if (r.type !== 'read') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { status: r.status, marks: r.marks, text: r.text, file: r.file, boxes: r.boxes, fields: r.fields };
  }

  /**
   * `window` is the window's id (the HWND in decimal on Windows), kept for pasting and filling into it later; `pid` is
   * the process that owns it (0 when nothing is in front).
   */
  async foreground(signal: AbortSignal): Promise<{ app: string; title: string; window: string; pid: number }> {
    const r = await this.request((id) => ({ type: 'foreground', id }), 'foreground', signal);
    if (r.type !== 'foreground') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { app: r.app, title: r.title, window: r.window, pid: r.pid };
  }

  /** The window in front, read without calling into its app, so a frozen app cannot stall it. */
  async front(signal: AbortSignal): Promise<FrontWindow> {
    const r = await this.request((id) => ({ type: 'front', id }), 'front', signal);
    if (r.type !== 'front') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { window: r.window, title: r.title, box: { x: r.x, y: r.y, w: r.w, h: r.h }, pid: r.pid };
  }

  /** A request is waiting for its reply: the helper answers in order, so a poll now would wait behind it. */
  get busy(): boolean {
    return this.unanswered.size > 0;
  }

  /**
   * Pastes into the ask's window by the clipboard route, run whole in the helper: up to 3 s waiting for hands off, then
   * 1 s before the clipboard is put back, so it gets PASTE_TIMEOUT_MS. `restored` is false when the user's clipboard
   * could not be put back.
   */
  async paste(req: PasteRequest, signal: AbortSignal): Promise<{ result: PasteResult; restored: boolean }> {
    // The helper answers in order: each request still ahead of the paste, aborted or not, may take its own time first.
    const ownMs = PASTE_TIMEOUT_MS + this.unanswered.size * this.timeoutMs;
    const r = await this.request((id) => {
      this.pastes.add(id);
      return pasteCommand(id, req);
    }, 'pasted', signal, ownMs);
    if (r.type !== 'pasted') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { result: r.result, restored: r.restored };
  }

  /** Writes one form field by UI Automation. */
  async setField(req: SetFieldRequest, signal: AbortSignal): Promise<SetFieldResult> {
    const r = await this.request((id) => setFieldCommand(id, req), 'set', signal);
    if (r.type !== 'set') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return r.result;
  }

  /**
   * Always settles: on the child's exit or error, or after a fallback that kills it: 1 s, or a paste's whole time while
   * one runs, as a kill mid-paste would leave the pasted text on the clipboard instead of the user's own.
   */
  stop(): Promise<void> {
    const fallbackMs = this.pastes.size > 0 ? PASTE_TIMEOUT_MS : 1000;
    this.failAll('stopped', 'the context helper was stopped');
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(fallback);
        resolve();
      };
      child.once('exit', done);
      child.once('error', done); // a child that failed to spawn never exits
      const fallback = setTimeout(() => {
        child.kill();
        done();
      }, fallbackMs);
      this.write(child, { type: 'shutdown' });
      child.stdin?.end();
    });
  }

  private request(
    make: (id: string) => ContextCommand,
    expect: ContextReply['type'],
    signal: AbortSignal,
    ownMs = this.timeoutMs,
  ): Promise<ContextReply> {
    if (signal.aborted) return Promise.reject(new ContextError('aborted', 'the ask was cancelled'));
    const child = this.child ?? this.start();
    const id = `r${this.nextId}`;
    this.nextId += 1;
    // The helper answers in order: a request behind a paste waits for it too. Restarting the helper mid-paste would
    // leave the pasted text on the clipboard instead of the user's own.
    const timeoutMs = ownMs + (this.pastes.size > 0 ? PASTE_TIMEOUT_MS : 0);
    return new Promise<ContextReply>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        settle();
        reject(new ContextError('aborted', 'the ask was cancelled'));
      };
      const timer = setTimeout(() => {
        settle();
        reject(new ContextError('timeout', `no reply from the context helper in ${timeoutMs} ms`));
        this.restart();
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        expect,
        resolve: (r) => {
          settle();
          resolve(r);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      });
      this.unanswered.add(id);
      this.write(child, make(id));
    });
  }

  private start(): ChildProcess {
    const run = this.opts.spawn ?? spawn;
    const child = run(this.opts.command, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    let gone = false;
    const onGone = (reason: string) => {
      if (gone) return;
      gone = true;
      if (this.child !== child) return; // a replaced helper: its requests were already failed
      this.child = null;
      this.failAll('exited', `the context helper stopped: ${reason}`);
    };
    child.on('error', (err) => onGone(err.message));
    child.on('exit', (code) => onGone(`exit code ${code}`));
    child.stdin?.on('error', () => undefined); // EPIPE after a crash; 'exit' handles it
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => this.onLine(child, line));
    return child;
  }

  /** A stuck helper is killed and a fresh one started, so the next ask finds it ready. */
  private restart(): void {
    const old = this.child;
    this.child = null;
    this.failAll('timeout', 'the context helper was restarted');
    old?.kill();
    this.start();
  }

  private onLine(child: ChildProcess, line: string): void {
    if (child !== this.child) return;
    const reply = parseContextLine(line);
    if (!reply) return;
    this.pastes.delete(reply.id); // done in the helper, even when its ask was cancelled meanwhile
    this.unanswered.delete(reply.id);
    const p = this.pending.get(reply.id); // none when aborted or timed out already
    if (p) {
      if (reply.type === 'error') p.reject(new ContextError(reply.code, reply.message));
      else if (reply.type !== p.expect) p.reject(new ContextError('bad', `expected ${p.expect}, got ${reply.type}`));
      else p.resolve(reply);
    }
    if (reply.type === 'read' && Object.values(reply.status).includes('slow')) {
      // The helper exits after this reply and reads nothing more: the next request must start a fresh one.
      this.child = null;
      this.failAll('exited', 'the context helper stopped after a slow probe');
      child.kill();
    }
  }

  /** Called whenever the helper goes away, so no paste nor any other request is still running in it either. */
  private failAll(code: ContextFailure, message: string): void {
    this.pastes.clear();
    this.unanswered.clear();
    for (const p of [...this.pending.values()]) p.reject(new ContextError(code, message));
  }

  private write(child: ChildProcess, cmd: ContextCommand): void {
    const stdin = child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(serializeContextCommand(cmd));
  }
}
