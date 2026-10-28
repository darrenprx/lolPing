import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strings, type Lang } from '../../shared/i18n';
import type { PingTag } from '../../shared/ipc';
import type { Platform } from '../../shared/platform';
import { sanitizeName } from '../../shared/roomProtocol';
import type { Settings } from '../../shared/settings';
import { AGENT_PRESETS, agentPrompt, presetForClient, type AgentRunSpec } from '../../shared/teammate/agents';
import { AskMachine, type AskFailure, type Spot } from '../../shared/teammate/askMachine';
import type { BridgeContent } from '../../shared/teammate/bridgeProtocol';
import type { SystemTextLayer } from '../../shared/teammate/contextProtocol';
import { overviewToPhysical, physicalToOverview, receiptPoint, type Rect, type Shot } from '../../shared/teammate/coords';
import type { FormField } from '../../shared/teammate/doRules';
import { editorFolder } from '../../shared/teammate/editorFolder';
import { frameSpots } from '../../shared/teammate/framing';
import { isSessionId, type ThreadRecord } from '../../shared/teammate/history';
import { intentFor } from '../../shared/teammate/intents';
import { bubbleMs, lineFromMarkdown, splitLine } from '../../shared/teammate/line';
import { resolveTarget, type Mark } from '../../shared/teammate/marks';
import { needsKey } from '../../shared/teammate/providers';
import { route, type RouteReason } from '../../shared/teammate/router';
import {
  TAG_NAME_MAX, isBuiltin, type AgentProfile, type BuiltinProfile, type Profile, type TeammateSettings,
} from '../../shared/teammate/settings';
import { threadAction } from '../../shared/teammate/threads';
import {
  CONSENT_TOOL, applyLimits, parseConsent, parseToolCall, toolDefs, visitorToolDefs, type ActionCall, type Target,
  type ToolCall, type ToolDef,
} from '../../shared/teammate/tools';
import type { BubbleState, CardState, MateAction, MateView, PutState } from '../../shared/teammateIpc';
import type { BridgeHandler } from '../mcp/bridgeServer';
import type { OverlayManager } from '../overlayManager';
import { RateLimiter } from '../rateLimiter';
import type { ActionRunner, RunInfo } from './actions';
import { AgentStartError, type AgentRun, type AgentRunner } from './agents/runner';
import { ContextError, type Capture, type ContextClient } from './contextClient';
import type { Doc } from './files';
import { FILE_READ_LIMIT, gather, readFileTool, type GatherDeps, type Gathered, type UsedItem } from './gather';
import type { HistoryStore } from './historyStore';
import type { MateWindows } from './mateWindows';
import { agentAsk, aimsExactly, canLook, firstTurn, systemPrompt, type AskContext } from './prompt';
import {
  ProviderError, type Part, type ProviderAdapter, type RawCall, type StreamHandlers, type Turn,
} from './providers/types';
import type { SecretStore } from './secrets';

type Point = { x: number; y: number };
type Timer = ReturnType<typeof setTimeout>;

export interface AskDeps {
  captureLease?: () => () => void;
  settings: () => Settings;
  /** False while lolPing is paused or the teammate is going down: agents' unprompted calls draw nothing then. */
  enabled: () => boolean;
  lang: () => Lang;
  secrets: Pick<SecretStore, 'key' | 'instructions' | 'available'>;
  context: Pick<ContextClient, 'capture' | 'foreground' | 'read'>;
  /** lolPing's main process, which owns the card and the words box: an ask made from one isn't made in that window. */
  ownPid: number;
  /** What gather reads the marks file and the file behind the window with. */
  readers: Omit<GatherDeps, 'context'>;
  adapter: (p: BuiltinProfile, key: string) => ProviderAdapter;
  overlay: Pick<OverlayManager,
    'spawnMate' | 'spawnMateEmote' | 'mateSaid' | 'clearMate' | 'fadeMate' | 'setMateTicket' | 'setCaptureExcluded'
    | 'displayAt' | 'toLocal' | 'toDip' | 'primaryDip'>;
  windows: Pick<MateWindows,
    'showBubble' | 'updateBubble' | 'hideBubble' | 'hideNow' | 'showCard' | 'updateCard' | 'hideCard' | 'placeOf'
    | 'setCaptureExcluded'>;
  history: Pick<HistoryStore, 'append' | 'current' | 'amend'>;
  /** The folder each ask's own capture folder goes in. */
  tempDir: () => string;
  /** A 512 px JPEG of a capture as base64, kept with the thread in history. */
  thumbnail: (jpeg: Buffer) => string;
  now: () => number;
  usage: (u: { input: number; output: number }) => void;
  /** Carries out the copy, event, paste, fill and open calls; without it they are dropped. */
  actions?: Pick<ActionRunner, 'take' | 'cancel' | 'described' | 'put' | 'askAgent'> & Pick<EventEmitter, 'on'>;
  /** The cursor in physical px: a reply in a thread opened from History asks there (no cursor: it does nothing). */
  cursor?: () => Point;
  /** Hears the foreground app of each ask, which the rules card offers as app names. */
  seenApp?: (app: string) => void;
  /** Makes, reads, writes and deletes an ask's capture folder; the file system by default. */
  files?: {
    read(path: string): Promise<Buffer>;
    write(path: string, text: string): Promise<void>;
    makeDir(path: string): Promise<void>;
    removeDir(path: string): Promise<void>;
  };
  /** Runs agent profiles; without it an agent ask fails as when lolPing's end of the bridge couldn't open. */
  agents?: {
    runner: Pick<AgentRunner, 'start'>;
    /** How the agent starts the bridge for ask token `ask`; null while lolPing's end of it isn't listening. */
    bridge: { command(ask: string): AgentRunSpec['bridge'] | null };
    /** lolPing's environment with the user's PATH, for the agent. */
    env: () => Promise<NodeJS.ProcessEnv>;
    /** Where an agent runs when its editor folder list is empty. */
    home: () => string;
    /** For the editor's window title, whose separator differs on macOS. */
    platform: Platform;
  };
}

/** Spec §7.1, §9.5: tool rounds per answer, the gap between a set of pings, and "the same spot". */
const MAX_ROUNDS = 6;
const PING_GAP_MS = 600;
/** The teammate's pings and emotes stay at least this long after its answer, and while its bubble or card is up. */
const MARKS_MIN_MS = 15_000;
const NEAR_PX = 40;
const RECEIVE_MS = 10_000;
const TOTAL_MS = 60_000;
const TITLE_MAX = 60;
/** The bubble sits up and to the right of the receipt, in DIPs. */
const BUBBLE_OFFSET = { x: 24, y: -24 };

const DONE: Part[] = [{ text: 'Done.' }];
/** A paste, fill, event or open waits for the user's consent or the form preview: not done yet. */
const ASKED: Part[] = [{ text: 'Asked the user; it happens if they agree.' }];
const NOT_AVAILABLE: Part[] = [{ text: 'Not available.' }];
/** What Claude Code is told when the user said no, or the card timed out, or the ask ended. */
const DECLINED = 'The user declined in lolPing.';
const INVALID_CONSENT = 'Refused: the permission request was not valid.';
const INVALID: Part[] = [{ text: 'Ignored: the arguments were not valid.' }];
const OVER_LIMIT: Part[] = [{
  text: 'Ignored: an answer has at most 6 pings, 1 emote, 1 paste, 1 fill, 1 event and 3 opens.',
}];
const ANSWER_NUDGE = 'Every ask ends with `say` (the one-line answer) and `answer` (the full answer in Markdown). '
  + 'Call both in the same round as your pings.';
/** Results that tell an agent its call did nothing. */
const REFUSED = new Set<Part[]>([NOT_AVAILABLE, INVALID, OVER_LIMIT]);
const ASK_OVER: BridgeContent[] = [{ text: 'That ask is over.' }];
const AGENTS_OFF: BridgeContent[] = [{
  text: 'The user hasn\'t let agents ping them. They can turn on Let agents ping me in lolPing\'s Teammate settings.',
}];
const PAUSED: BridgeContent[] = [{ text: 'lolPing is paused.' }];
const BUSY: BridgeContent[] = [{ text: 'lolPing is busy; try again in a moment.' }];
const TOO_MANY: BridgeContent[] = [{ text: 'Too many pings.' }];
/** Unprompted calls a second from one client, and from all of them (under this key). */
const VISITOR_RATE = 5;
const VISITOR_RATE_ALL = 10;
const ALL_VISITORS = '*';
/** An agent's error goes on the line cut to this many characters. */
const AGENT_ERROR_MAX = 200;
const ASK_SECRET_BYTES = 16;

interface Run {
  machine: AskMachine;
  abort: AbortController;
  deadlines: Timer[];
  ended: boolean;
  /** Every spot of the ask, in order; `spot` is the last, which decides the question and where the answer sits. */
  spots: Spot[];
  spot: Spot;
  receipt: Point;
  display: { id: number; rect: Rect } | null;
  intent: ReturnType<typeof intentFor>;
  words: string | null;
  thread: ThreadRecord | null;
  /** The card opens by itself: Whole picture, Translate, or Push on the spot just answered. */
  autoCard: boolean;
  lang: Lang;
  tag: PingTag;
  emotes: boolean;
  profile: Profile | null;
  /** Why the profile was chosen, in words, for the card footer. */
  route: string;
  /** An agent's ask: the token its bridge calls carry and the tools it is offered. */
  agent: { token: string; tools: ToolDef[] } | null;
  /** An agent's unprompted call, which isn't an ask: where its marks go (physical px). */
  visitor: { point: Point } | null;
  /** The folder the agent ran in, as the card footer names it, and its path; null for a built-in profile. */
  folder: string;
  cwd: string | null;
  /** The agent session this answer came from, kept with the thread so the next ask in it resumes it. */
  session: NonNullable<ThreadRecord['agent']> | null;
  /** The agent answering, while it runs: finish() reads its session when the answer is kept before it exits. */
  agentRun: AgentRun | null;
  shot: Shot | null;
  app: string;
  title: string;
  /** The window the ask was made in (an HWND in decimal on Windows), for pasting and filling into it later. */
  window: string;
  thumb: string;
  text: string;
  /** The bubble's line; the first `say` in full, which the card and history keep; what the line cut off. */
  line: string;
  said: string;
  rest: string;
  /** Answers and later says, for the card. */
  markdown: string[];
  tokens: number | null;
  calls: ToolCall[];
  /** Says shown while their turn was still streaming: when the turn ends, play() skips each of them once. */
  early: string[];
  pings: number;
  /** Where its pings and emotes went (physical px): asking on one of them continues the thread. */
  marks: Point[];
  /** This ask's capture folder, removed when the ask ends however it ends. */
  dir: string;
  /** The screen read at the held releases, which this ask took over; null: it reads when it starts. */
  reading: Reading | null;
  /** Controls and text lines near the spot, which the teammate's pings snap onto. */
  screenMarks: Mark[];
  /** The whole file behind the window, which read_file serves. */
  doc: Doc | null;
  used: UsedItem[];
  skipped: boolean;
  /** File characters `read_file` has given this ask. */
  fileRead: number;
  /** What the context read at the ask: the focused field and selection, the form fields, the element under the spot. */
  system: SystemTextLayer | null;
  fields: FormField[];
  box: Rect | null;
  /** What the action runner is given with each call of this ask; made at the first one. */
  info: RunInfo | null;
  /** The page under its marks moved: no more of its pings or emotes are drawn, and its later bubble isn't watched. */
  stale: boolean;
  /** Its bubble went with the stale fade (or its line hadn't come yet): a later say brings the line back, once. */
  bubbleBack: boolean;
}

/** What an ask is read for: its spots, the last one, its intent, display, language and folder. */
interface ReadAt {
  spots: Spot[];
  spot: Spot;
  intent: ReturnType<typeof intentFor>;
  display: { id: number; rect: Rect } | null;
  lang: Lang;
  dir: string;
}

/** The window in front and where the ask goes: a built-in profile with its key (null: none), or an agent. */
interface Front {
  app: string;
  title: string;
  window: string;
  profile: Profile | null;
  key: string | null;
  route: string;
}

/** The context around the spots and the capture it framed. */
interface Scene {
  layers: Gathered;
  cap: Capture;
  shot: Shot;
  overviewJpeg: Buffer;
  zoomJpegs: Buffer[];
}

/** Everything of an ask before anything is sent; made at the ask, or ahead of it at the held releases. */
interface Reading {
  spots: Spot[];
  dir: string;
  abort: AbortController;
  /** Null when the read was stopped. */
  front: Promise<Front | null>;
  /** Starts the context read and the capture at the first call; later calls share them. Null when stopped. */
  scene: () => Promise<Scene | null>;
  /** Settles once nothing of the read can write into its folder. */
  settled: () => Promise<void>;
}

/** A read made ahead serves an ask on the same spots, in the same order. */
const sameSpots = (a: readonly Spot[], b: readonly Spot[]): boolean => a.length === b.length && a.every((s, i) => (
  s.intent === b[i].intent && s.displayId === b[i].displayId && s.phys.x === b[i].phys.x && s.phys.y === b[i].phys.y
));

const isAction = (c: ToolCall): c is ActionCall => (
  c.tool === 'copy' || c.tool === 'event' || c.tool === 'paste' || c.tool === 'fill' || c.tool === 'open'
);

/** One ask and its answer as the card shows them. */
const entryPair = (
  label: string, words: string | null, line: string, markdown: string, tagName: string,
): CardState['entries'] => [
  { kind: 'ask', label, markdown: words ?? '' },
  { kind: 'answer', label: tagName, line, markdown },
];

/** An ask's label on the card; one about several spots says how many. */
const askLabel = (label: string, spots: number, lang: Lang): string => (
  spots > 1 ? `${label} · ${strings(lang).teammate.ask.spots(spots)}` : label
);

/** One thing the answer used, as the card footer names it. */
function usedLabel(u: UsedItem, lang: Lang): string {
  const t = strings(lang).teammate.ask;
  switch (u.kind) {
    case 'selection': return t.usedSelection;
    case 'text': return t.usedText;
    case 'marks': return t.usedMarks;
    case 'address': return t.usedAddress;
    case 'file': return t.usedFile(u.name, u.unit, u.from, u.to);
  }
}

const near = (p: Point, list: readonly Point[]): boolean =>
  list.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= NEAR_PX);

function failureOf(err: unknown): AskFailure {
  if (err instanceof ProviderError) return err.kind;
  if (err instanceof ContextError) return 'capture';
  return 'other';
}

/** The same `file` and intent decide the tools and the prompt's rules for them, so the two never disagree. */
const toolsFor = (run: Run, ctx: AskContext): ToolDef[] => toolDefs({
  emotes: run.emotes, spots: run.spots.length, file: ctx.file !== null, look: canLook(run.intent.def.id),
  kind: run.intent.def.kind, form: (ctx.fields?.length ?? 0) > 0, selection: (ctx.system?.selection ?? '') !== '',
});

/** Whether the preset's permission prompts come to lolPing's `consent` tool (Claude Code only). */
const asksConsent = (profile: AgentProfile): boolean => (
  profile.preset !== 'custom' && AGENT_PRESETS[profile.preset].consent
);

/** An agent's answer is what it drew, whatever its exit code says. */
const drew = (run: Run): boolean => run.line !== '' || run.markdown.length > 0 || run.marks.length > 0;

/** A path's last part, whichever separator it uses: a profile's folders may be written either way. */
const baseName = (p: string): string => p.split(/[\\/]/).filter((s) => s !== '').pop() ?? p;

/** Where an agent runs, and how the card footer names it. */
function agentFolder(
  profile: AgentProfile, ask: { app: string; title: string }, agents: NonNullable<AskDeps['agents']>, lang: Lang,
): { path: string; label: string } {
  const words = strings(lang).teammate.ask;
  if (profile.folder.kind === 'fixed') {
    return { path: profile.folder.path, label: words.folder(baseName(profile.folder.path)) };
  }
  const picked = editorFolder(profile.folder.folders, ask, agents.platform);
  if (!picked) return { path: agents.home(), label: words.folderHome };
  const name = baseName(picked.path);
  return { path: picked.path, label: picked.matched ? words.folder(name) : words.folderFirst(name) };
}

const bridgeContent = (p: Part): BridgeContent => ('text' in p
  ? { text: p.text }
  : { image: { mime: p.image.mime, data: p.image.data.toString('base64') } });

/**
 * lolPing's end of the bridge: an agent started for an ask lists and calls that ask's tools, and any other client is
 * an agent pinging the user unprompted. A connection's hello isn't a receipt, since dsh opens a probe connection first.
 */
export function bridgeHandler(
  c: Pick<AskController, 'agentTools' | 'agentCall' | 'visitorTools' | 'visitorCall'>,
): BridgeHandler {
  return {
    hello: () => undefined,
    list: (s) => (s.ask === null ? c.visitorTools() : c.agentTools(s.ask) ?? []),
    call: async (s, name, args) => (s.ask === null
      ? c.visitorCall(s.client, name, args)
      : c.agentCall(s.ask, name, args)),
  };
}

/** The routing reason as the card footer words it. */
function routeLabel(reason: RouteReason, t: TeammateSettings, lang: Lang): string {
  const words = strings(lang).teammate.ask.route;
  switch (reason.kind) {
    case 'rule': return words.rule(t.rules[reason.index]?.app ?? '');
    case 'deep': return words.deep;
    case 'doIt': return words.doIt;
    case 'default': return words.default;
  }
}

/**
 * Turns an ask into an answer on screen: capture, model turns, then the receipt, the line, the teammate's pings and
 * emotes, the card and the history entry. One ask at a time; anything from an ask that was replaced or cancelled is
 * dropped. Emits 'state' (running: boolean) when an ask starts or ends, and 'watch' ({ window } of the ask whose
 * marks or bubble came up, or null once both are gone) for the stale watch.
 */
export class AskController extends EventEmitter {
  private run: Run | null = null;
  /** The run whose answer is on screen, running or not: the bubble's and card's actions act on it. */
  private shown: Run | null = null;
  private readonly files: NonNullable<AskDeps['files']>;
  private marksShown = false;
  private bubbleShown = false;
  private cardShown = false;
  private bubbleTimer: Timer | null = null;
  private bubbleEndsAt = 0;
  private fadeTimer: Timer | null = null;
  private readonly pingTimers = new Set<Timer>();
  /** The run the stale watch is on, from its first mark or bubble until both are gone. */
  private watched: Run | null = null;
  private nextPingAt = 0;
  /** When the answer on screen finished or failed; its marks stay MARKS_MIN_MS from then. Null while it is coming. */
  private answeredAt: number | null = null;
  private excluded = 0;
  /** The thread asks continue: kept here so it works with history off or paused, and across a pause. */
  private thread: ThreadRecord | null = null;
  /** A thread opened from History that the card shows; its reply box continues it. */
  private viewed: ThreadRecord | null = null;
  /** The last answer's history entry: an action done after it was written (after consent) is added to it. */
  private entry: { ask: string; at: number; thread: Promise<string | null> } | null = null;
  /** The runner's put button for the answer on screen: the bubble and the card show it. */
  private put: PutState = null;
  /**
   * The run whose bubble or card the runner hid for a paste. Only that one comes back (as the bubble) when the paste
   * doesn't land; one the user closed, or whose time ran out, stays closed.
   */
  private hiddenForPut: Run | null = null;
  /** A consent card or form preview waits for the user: the bubble under it keeps its line and button till it goes. */
  private asking = false;
  private readonly visitorRate: RateLimiter;
  /** The screen read for the spots held so far; the ask on them takes it over. */
  private prepared: Reading | null = null;

  constructor(private readonly deps: AskDeps) {
    super();
    this.visitorRate = new RateLimiter(deps.now);
    this.files = deps.files ?? {
      read: (p) => readFile(p),
      write: (p, text) => writeFile(p, text, 'utf8'),
      makeDir: async (p) => {
        await mkdir(p, { recursive: true });
      },
      removeDir: (p) => rm(p, { recursive: true, force: true }),
    };
    deps.actions?.on('described', (ask: string, done: string[]) => this.amendDone(ask, done));
    deps.actions?.on('put', (state: PutState) => this.showPut(state));
    deps.actions?.on('asking', (on: boolean) => this.onAsking(on));
  }

  get running(): boolean {
    return this.run !== null;
  }

  /** `spots`: one or more, in order; the last decides the question, and the receipt, bubble and card sit at it. */
  ask(spots: readonly Spot[], words?: { text: string; newThread: boolean }): void {
    const spot = spots.at(-1);
    if (!spot) return;
    const reading = this.adopt(spots);
    // An agent's unprompted marks aren't the teammate's: asking on one doesn't continue a thread.
    const prev = this.shown?.visitor ? null : this.shown;
    const settings = this.deps.settings();
    const t = settings.teammate;
    const lang = this.deps.lang();
    const intent = intentFor(t, spot.intent, lang);
    const machine = new AskMachine(this.deps.now, { receiveMs: RECEIVE_MS, totalMs: TOTAL_MS });
    for (const s of spots) machine.addSpot(s);

    this.stopRun();
    this.deps.actions?.cancel(); // a consent card or form preview of the last answer goes, and nothing of it runs
    this.answeredAt = null;
    this.clearMarks();
    this.hideBubble();
    this.clearTimer('fade');
    this.viewed = null;
    this.deps.overlay.setMateTicket(machine.id);

    const current = this.currentThread();
    const onTeammate = prev !== null && near(spot.phys, prev.marks);
    const thread = threadAction(spot.intent, current, { onTeammate, newThread: words?.newThread }) === 'continue'
      ? current : null;
    if (!thread) this.hideCard();
    const samePush = spot.intent === 'push' && prev !== null && near(spot.phys, [prev.spot.phys]);
    const display = this.deps.overlay.displayAt(spot.phys);

    const run: Run = {
      machine, abort: reading?.abort ?? new AbortController(), deadlines: [], ended: false, spots: [...spots], spot,
      display, receipt: display ? receiptPoint(spot.phys, display.rect) : spot.phys,
      intent, words: words?.text ?? null, thread, autoCard: intent.def.autoCard || samePush, lang,
      tag: { name: t.tagName, color: t.tagColor, rgb: t.tagColorCustom }, emotes: t.emotes,
      profile: null, route: '', agent: null, visitor: null, folder: '', cwd: null, session: null, agentRun: null,
      shot: null, app: '', title: '', window: '', thumb: '', text: '', line: '', said: '',
      rest: '', markdown: [], tokens: null,
      calls: [], early: [], pings: 0, marks: [], dir: reading?.dir ?? join(this.deps.tempDir(), machine.id), reading,
      screenMarks: [], doc: null, used: [], skipped: false, fileRead: 0,
      system: null, fields: [], box: null, info: null, stale: false, bubbleBack: false,
    };
    this.run = run;
    this.shown = run;
    this.nextPingAt = 0;
    this.bubbleEndsAt = 0;
    this.emit('state', true);
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, true));
    this.go(run).catch((err: unknown) => console.warn('[teammate] ask failed:', err));
  }

  /**
   * Reads the screen for held spots before their ask goes: the window in front, the route, the context and the
   * capture. Nothing on screen changes and the running ask goes on; the ask on the same spots takes it over.
   */
  prepare(spots: readonly Spot[]): void {
    this.dropPrepared();
    const spot = spots.at(-1);
    if (!spot) return;
    const t = this.deps.settings().teammate;
    const lang = this.deps.lang();
    const display = this.deps.overlay.displayAt(spot.phys);
    const reading = this.read({
      spots: [...spots], spot, intent: intentFor(t, spot.intent, lang), display, lang,
      dir: join(this.deps.tempDir(), `read-${randomUUID()}`),
    }, new AbortController());
    this.prepared = reading;
    // An ask that fails before its capture (no profile or key, no display) doesn't capture ahead either.
    reading.front.then((f) => {
      const goes = f?.profile && (!isBuiltin(f.profile) || f.key !== null) && display;
      return goes ? reading.scene() : null;
    }).catch(() => undefined);
  }

  /** The held spots went without an ask: their read stops and its folder goes. */
  dropPrepared(): void {
    const reading = this.prepared;
    this.prepared = null;
    if (reading) this.drop(reading);
  }

  /** The thread the next ask continues: the last answer's, or one History made current. */
  currentThread(): ThreadRecord | null {
    return this.thread ?? this.deps.history.current();
  }

  /** History dropped a thread (`id`), or every thread (no id): asks no longer continue it. */
  forgetThread(id?: string): void {
    if (id === undefined || this.thread?.id === id) this.thread = null;
    if (id === undefined || this.viewed?.id === id) this.viewed = null;
  }

  /** History's Continue: the next push, reply or words go into this thread. */
  continueThread(record: ThreadRecord): void {
    this.thread = record;
  }

  /** History's Open: the thread as a card at `at` (DIPs), in place of what the teammate had on screen. */
  showThread(record: ThreadRecord, at: Point): void {
    this.cancel('user');
    const t = this.deps.settings().teammate;
    const lang = this.deps.lang();
    this.deps.windows.showCard(at, {
      view: 'card', lang, tag: { name: t.tagName, color: t.tagColor, rgb: t.tagColorCustom }, title: record.title,
      entries: this.threadEntries(record, lang, t.tagName), streaming: false,
      footer: { profile: record.profile, model: '', route: '', tokens: null, used: [] }, put: null,
    });
    this.cardShown = true;
    this.viewed = record;
  }

  /** The bubble's time stops while a card or preview waits, and starts again whole when it goes. */
  private onAsking(on: boolean): void {
    this.asking = on;
    const run = this.shown;
    if (!run || !this.bubbleShown) return;
    if (on) this.clearTimer('bubble');
    else this.armBubble(run, run.line);
  }

  /** The user moved the bubble: they are reading it, so its time on screen starts again. */
  onDragged(view: MateView): void {
    const run = this.shown;
    if (view !== 'bubble' || !run || !this.bubbleShown || !this.bubbleTimer) return;
    this.armBubble(run, run.line);
  }

  /** What the bubble and card ask for; the rest (copy, link, history) is the app's to handle. */
  onTeammateAction(view: MateView, a: MateAction): void {
    const run = this.shown;
    if (!run && this.viewed && view === 'card' && (a.t === 'reply' || a.t === 'deep')) return this.askFromViewed(a);
    switch (a.t) {
      case 'more':
        if (view === 'bubble' && run) this.openCard(run, true);
        break;
      case 'dismiss':
        this.hideBubble();
        break;
      case 'close':
        this.hideCard();
        this.viewed = null;
        break;
      // An agent's card has neither: they would ask the user's own teammate about the agent's answer.
      case 'reply':
        if (run && !run.visitor) this.ask([{ ...run.spot, intent: 'generic' }], { text: a.text, newThread: false });
        break;
      case 'deep':
        if (run && !run.visitor) this.ask([{ ...run.spot, intent: 'allin' }]);
        break;
      case 'put':
        // The click is the consent; the runner checks it belongs to the action it has for this ask.
        if (run?.info && (view === 'bubble' || view === 'card')) void this.deps.actions?.put(run.info, view);
        break;
      default:
        break;
    }
  }

  /**
   * The runner hides the bubble before a click paste, so nothing of lolPing's is over the point it clicks. At once:
   * the helper checks the point as soon as the paste starts, and a bubble still fading out would be found there.
   */
  hideBubbleForPut(): void {
    if (!this.bubbleShown) return this.deps.windows.hideNow('bubble'); // one still fading out from a hide just before
    this.hideBubble('now');
    this.hiddenForPut = this.shown;
  }

  /** The runner closes a card that had focus before a paste, so the keyboard goes back to the app. */
  hideCardForPut(): void {
    if (!this.cardShown) return;
    this.hideCard();
    this.hiddenForPut = this.shown;
  }

  /** Stops the running ask, if any, and clears everything the teammate has on screen. */
  cancel(_reason: 'new' | 'pause' | 'helper' | 'user'): void {
    this.stopRun();
    this.deps.actions?.cancel();
    // Unconditionally: whatever the flags say, nothing of the teammate may stay on screen after a pause.
    this.marksShown = true;
    this.clearMarks();
    this.bubbleShown = true;
    this.hideBubble();
    this.cardShown = true;
    this.hideCard();
    this.clearTimer('fade');
    this.answeredAt = null;
    this.shown = null;
    this.viewed = null;
  }

  /**
   * The page under the teammate's marks moved: its pings, emotes and bubble fade (the card stays, it holds the answer
   * apart from the page), and a running ask draws no more of them.
   */
  stale(): void {
    for (const timer of this.pingTimers) clearTimeout(timer);
    this.pingTimers.clear();
    for (const run of [this.shown, this.watched]) if (run) run.stale = true;
    // Only a bubble the fade took comes back: one the user dismissed, or a card they closed, stays closed.
    if (this.shown && !this.cardShown && (this.bubbleShown || !this.shown.line)) this.shown.bubbleBack = true;
    if (this.marksShown) {
      this.deps.overlay.fadeMate();
      this.marksShown = false;
    }
    this.hideBubble('stale');
    this.watchGone();
  }

  /**
   * The bridge's tools/list for the agent of ask token `ask`; null when no such ask is running. The first one is the
   * receipt (spec §16): a connection alone isn't, since dsh opens a probe first.
   */
  agentTools(ask: string): ToolDef[] | null {
    const run = this.agentRun(ask);
    if (!run?.agent) return null;
    this.received(run);
    return run.agent.tools;
  }

  /** One tool call from the agent of ask token `ask`, drawn as a model's would be; an image comes back as base64. */
  async agentCall(ask: string, name: string, args: unknown): Promise<{ content: BridgeContent[]; isError: boolean }> {
    const run = this.agentRun(ask);
    const agent = run?.agent;
    if (!run || !agent) return { content: ASK_OVER, isError: true };
    if (name === 'consent') return this.agentConsent(run, args);
    this.received(run); // an agent that calls without listing has the tools all the same
    run.machine.answering();
    const offered = new Set(agent.tools.map((d) => d.name));
    // One look per ask, as for a model; taken away before it runs, so two at once can't both look.
    if (name === 'look') agent.tools = agent.tools.filter((d) => d.name !== 'look');
    const raw: RawCall = { id: 'agent', name, args: JSON.stringify(args ?? {}) };
    const step = await this.play(run, [raw], offered, false);
    const content = step.results[0]?.content ?? DONE;
    return { content: content.map(bridgeContent), isError: REFUSED.has(content) };
  }

  /**
   * Claude Code's permission prompt, asked of the user on a consent card. The reply is the text Claude Code reads
   * (spec §16), and a decline is an answer, not an error.
   */
  private async agentConsent(run: Run, args: unknown): Promise<{ content: BridgeContent[]; isError: boolean }> {
    if (!run.profile || run.profile.kind !== 'agent' || !asksConsent(run.profile)) {
      return { content: NOT_AVAILABLE.map(bridgeContent), isError: true };
    }
    this.received(run);
    const req = parseConsent(args);
    const actions = this.deps.actions;
    const answer = req && actions ? await actions.askAgent(this.runInfo(run), req, run.abort.signal) : 'deny';
    const reply = answer === 'allow' && req
      ? { behavior: 'allow', updatedInput: req.input }
      : { behavior: 'deny', message: req ? DECLINED : INVALID_CONSENT };
    return { content: [{ text: JSON.stringify(reply) }], isError: false };
  }

  /** What an agent may call without an ask, when the user lets agents ping them. */
  visitorTools(): ToolDef[] {
    return visitorToolDefs(this.deps.settings().teammate.emotes);
  }

  /**
   * An unprompted call from an agent the user runs elsewhere (no ask token): drawn at the cursor like the teammate's
   * marks, with the agent's name tag. Nothing of it goes into history or a thread.
   */
  async visitorCall(
    client: { name: string }, name: string, args: unknown,
  ): Promise<{ content: BridgeContent[]; isError: boolean }> {
    if (!this.deps.enabled()) return { content: PAUSED, isError: true };
    if (!this.deps.settings().teammate.agentsCanPing) return { content: AGENTS_OFF, isError: true };
    if (this.busy()) return { content: BUSY, isError: true };
    if (!this.visitorRate.allow(client.name, VISITOR_RATE) || !this.visitorRate.allow(ALL_VISITORS, VISITOR_RATE_ALL)) {
      return { content: TOO_MANY, isError: true };
    }
    const cursor = this.deps.cursor?.();
    const display = cursor ? this.deps.overlay.displayAt(cursor) : null;
    if (!cursor || !display) return { content: NOT_AVAILABLE.map(bridgeContent), isError: true };
    const run = this.visitorRun(client.name, cursor, display);
    // lolPing picks the place; a position the agent sends anyway is ignored (the parser wants one).
    const given = typeof args === 'object' && args !== null && !Array.isArray(args) ? { ...args, x: 0, y: 0 } : args;
    const raw: RawCall = { id: 'visitor', name, args: JSON.stringify(given ?? {}) };
    const step = await this.play(run, [raw], new Set(this.visitorTools().map((d) => d.name)), false);
    const content = step.results[0]?.content ?? DONE;
    const refused = REFUSED.has(content);
    if (!refused) {
      this.shown = run;
      this.answeredAt = this.deps.now();
      this.scheduleFade();
    }
    return { content: content.map(bridgeContent), isError: refused };
  }

  /** A thread opened from History has no spot of its own: its reply asks at the cursor. */
  private askFromViewed(a: Extract<MateAction, { t: 'reply' | 'deep' }>): void {
    const phys = this.deps.cursor?.();
    const display = phys ? this.deps.overlay.displayAt(phys) : null;
    if (!phys || !display || !this.viewed) return;
    if (a.t === 'deep') return this.ask([{ intent: 'allin', phys, displayId: display.id }]);
    this.thread = this.viewed;
    this.ask([{ intent: 'generic', phys, displayId: display.id }], { text: a.text, newThread: false });
  }

  /**
   * An ask runs, a consent card waits, or the user's own answer or History card is on screen: an agent waits. A put
   * button counts only with its answer up, or hidden for a paste that brings it back if it doesn't land.
   */
  private busy(): boolean {
    const own = this.shown !== null && !this.shown.visitor;
    const mine = own && (this.bubbleShown || this.cardShown);
    const pasting = own && this.put !== null && this.hiddenForPut === this.shown;
    return this.run !== null || this.asking || mine || pasting || this.viewed !== null;
  }

  /** The profile of the agent's preset wins its name and colour; any other client is named as it names itself. */
  private visitorTag(client: string): PingTag {
    const t = this.deps.settings().teammate;
    const preset = presetForClient(client);
    const profile = preset ? t.profiles.find((p) => p.kind === 'agent' && p.preset === preset) : undefined;
    if (profile) {
      return { name: profile.name.slice(0, TAG_NAME_MAX), color: profile.tagColor, rgb: profile.tagColorCustom };
    }
    const name = preset ? AGENT_PRESETS[preset].name : client;
    return { name: sanitizeName(name.slice(0, 256), 'Agent', TAG_NAME_MAX), color: t.tagColor, rgb: t.tagColorCustom };
  }

  /** A run to draw one unprompted call with. It never counts as running: its bubble goes with its time. */
  private visitorRun(client: string, cursor: Point, display: { id: number; rect: Rect }): Run {
    const t = this.deps.settings().teammate;
    const lang = this.deps.lang();
    const point = receiptPoint(cursor, display.rect);
    const spot: Spot = { intent: 'generic', phys: cursor, displayId: display.id };
    return {
      machine: new AskMachine(this.deps.now, { receiveMs: RECEIVE_MS, totalMs: TOTAL_MS }),
      abort: new AbortController(), deadlines: [], ended: true,
      spots: [spot], spot, receipt: point, display,
      intent: intentFor(t, 'generic', lang), words: null, thread: null, autoCard: true, lang,
      tag: this.visitorTag(client), emotes: t.emotes, profile: null, route: '', agent: null, visitor: { point },
      folder: '', cwd: null, session: null, agentRun: null, shot: null, app: '', title: '', window: '', thumb: '',
      text: '', line: '', said: '', rest: '', markdown: [], tokens: null, calls: [], early: [], pings: 0, marks: [],
      dir: '', reading: null, screenMarks: [], doc: null, used: [], skipped: false, fileRead: 0, system: null, fields: [],
      box: null, info: null, stale: false, bubbleBack: false,
    };
  }

  private alive(run: Run): boolean {
    return this.run === run && !run.ended;
  }

  private async go(run: Run): Promise<void> {
    try {
      await this.answer(run);
    } catch (err) {
      if (this.alive(run)) this.fail(run, failureOf(err));
    } finally {
      // Also when the ask was cancelled mid-capture: context-helper may still write into the folder, and fails once
      // it is gone. Whatever slips past that is removed with the whole temp folder when the teammate stops or starts.
      this.files.removeDir(run.dir).catch(() => undefined);
    }
  }

  private async answer(run: Run): Promise<void> {
    const { deps } = this;
    const signal = run.abort.signal;
    // The total time runs from the first helper call, or from the send for a read made ahead, so a capture, helper or
    // file read that hangs can't hold it up.
    this.deadline(run, TOTAL_MS, () => this.fail(run, 'timeout'));
    const reading = run.reading ?? this.read(run, run.abort);
    const front = await reading.front;
    if (!front || !this.alive(run)) return;
    run.app = front.app;
    run.title = front.title;
    run.window = front.window;
    if (front.profile && !isBuiltin(front.profile)) return this.askAgent(run, front.profile, front.route, reading);
    const profile = front.profile && isBuiltin(front.profile) ? front.profile : null;
    const { key } = front;
    if (!profile || key === null) return this.fail(run, 'noProfile');
    if (!run.display) return this.fail(run, 'capture');
    run.profile = profile;
    run.route = front.route;
    run.machine.startGathering();

    const scene = await reading.scene();
    if (!scene || !this.alive(run)) return;
    const ctx = this.useScene(run, scene);
    const adapter = deps.adapter(profile, key);
    const system = systemPrompt(ctx);
    let tools = toolsFor(run, ctx);
    const turns: Turn[] = [firstTurn(ctx)];
    run.machine.sent();
    this.deadline(run, RECEIVE_MS, () => {
      if (run.machine.phase === 'sent') this.fail(run, 'notReceived');
    });

    let nudged = false;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await adapter.turn({ system, turns, tools, model: profile.model }, this.handlers(run), signal);
      if (!this.alive(run)) return;
      this.received(run); // a provider that streams nothing before its answer still gets a receipt
      run.machine.answering();
      run.text += result.text;
      turns.push({ role: 'assistant', text: result.text, calls: result.calls });
      const last = round === MAX_ROUNDS - 1;
      const step = await this.play(run, result.calls, new Set(tools.map((d) => d.name)), last);
      if (!this.alive(run)) return;
      // One look round per ask: each costs a whole round trip.
      if (result.calls.some((c) => c.name === 'look')) tools = tools.filter((d) => d.name !== 'look');
      // Pings alone leave nothing to read. A round that goes on anyway carries the reminder for free; a round that
      // would end the ask is followed by one more, once.
      const unanswered = !run.line && run.markdown.length === 0 && !run.text.trim();
      if (!step.again && (!unanswered || nudged || last)) break;
      if (!step.again) nudged = true;
      if (result.calls.length === 0) {
        turns.push({ role: 'user', parts: [{ text: ANSWER_NUDGE }] });
        continue;
      }
      const lastResult = step.results[step.results.length - 1];
      if (unanswered && lastResult) lastResult.content = [...lastResult.content, { text: ANSWER_NUDGE }];
      turns.push({ role: 'tool', results: step.results });
    }
    await this.finish(run);
  }

  /** The ask on `spots` takes the read made ahead for them; any other read made ahead stops. */
  private adopt(spots: readonly Spot[]): Reading | null {
    const reading = this.prepared;
    this.prepared = null;
    if (reading && sameSpots(reading.spots, spots)) return reading;
    if (reading) this.drop(reading);
    return null;
  }

  private drop(reading: Reading): void {
    reading.abort.abort();
    // As for an ask (go): the folder goes once nothing of the read can write into it.
    reading.settled()
      .then(() => this.files.removeDir(reading.dir))
      .catch(() => undefined);
  }

  /**
   * Starts the part of an ask before anything is sent, for either kind of profile: the window in front and the route,
   * then, at the first `scene()`, the context and the capture it frames. `abort` stops it.
   */
  private read(at: ReadAt, abort: AbortController): Reading {
    const { deps } = this;
    const { signal } = abort;
    const front = (async (): Promise<Front | null> => {
      const fg = await deps.context.foreground(signal).catch(() => ({ app: '', title: '', window: '', pid: 0 }));
      if (signal.aborted) return null;
      deps.seenApp?.(fg.app);
      const t = deps.settings().teammate;
      const routed = route(t, { intent: at.spot.intent, deep: at.intent.def.deep, app: fg.app, title: fg.title });
      const builtin = routed && isBuiltin(routed.profile) ? routed.profile : null;
      const stored = builtin && deps.secrets.available() ? deps.secrets.key(builtin.id) : null;
      return {
        app: fg.app, title: fg.title,
        // Asked from the card's reply box or Whole picture: the page the marks point at is the next window in front.
        window: fg.pid === deps.ownPid ? '' : fg.window,
        profile: routed?.profile ?? null, key: stored ?? (builtin && !needsKey(builtin) ? '' : null),
        route: routed ? routeLabel(routed.reason, t, at.lang) : '',
      };
    })();
    let scene: Promise<Scene | null> | null = null;
    return {
      spots: at.spots, dir: at.dir, abort, front,
      scene: () => {
        scene ??= front.then((f) => (f ? this.readScene(at, f.title, signal) : null));
        return scene;
      },
      settled: async () => {
        await front;
        await scene?.catch(() => null);
      },
    };
  }

  /** Reads the context, then the capture it frames; null when the read was stopped meanwhile. */
  private async readScene(at: ReadAt, title: string, signal: AbortSignal): Promise<Scene | null> {
    const { deps } = this;
    const rect = at.display?.rect;
    if (signal.aborted) return null;
    if (!rect) throw new ContextError('capture', 'no display under the spot');
    // The context comes first: the boxes around the spot decide what the capture shows.
    await this.files.makeDir(at.dir);
    const allin = at.intent.def.id === 'allin';
    const phys = at.spots.map((s) => s.phys);
    const layers = await gather({ context: deps.context, ...deps.readers }, {
      settings: deps.settings().teammate.context, spots: phys, dir: at.dir, allin, title,
      act: at.intent.def.kind === 'act',
    }, signal);
    if (signal.aborted) return null;
    const framing = frameSpots(at.intent.def.id, layers.boxes, rect, phys);
    const cap = await this.capture({ rect, dir: at.dir, signal }, phys, framing);
    if (signal.aborted) return null;
    const shot: Shot = { area: framing.area, overview: cap.overview, zooms: cap.zooms.map((z) => z.rect) };
    const overviewJpeg = await this.files.read(cap.overviewPath);
    const zoomJpegs = await Promise.all(cap.zooms.map((z) => this.files.read(z.path)));
    if (signal.aborted) return null;
    return { layers, cap, shot, overviewJpeg, zoomJpegs };
  }

  /** The run takes what its read found; returns the context its prompt is made from. */
  private useScene(run: Run, scene: Scene): AskContext {
    const { deps } = this;
    const { layers, shot, overviewJpeg, zoomJpegs } = scene;
    run.shot = shot;
    run.thumb = deps.thumbnail(zoomJpegs.at(-1) ?? overviewJpeg); // the last spot's close-up: the ask sits there
    run.screenMarks = layers.marks;
    run.system = layers.system;
    run.fields = layers.fields;
    run.box = layers.boxes[run.spots.length - 1]?.[0] ?? null; // under the last spot, where the answer sits
    run.doc = layers.doc;
    // Marks are read for every ask so pings snap, but only the asks whose prompt lists them used them.
    run.used = aimsExactly(run.intent.def.id) ? layers.used : layers.used.filter((u) => u.kind !== 'marks');
    run.skipped = layers.skipped;
    return {
      lang: run.lang, intent: run.intent, words: run.words, app: run.app, title: run.title,
      shot, spots: run.spots.map((s) => physicalToOverview(shot, s.phys)), overviewJpeg, zoomJpegs, thread: run.thread,
      instructions: deps.secrets.instructions(), emotes: run.emotes, marks: layers.marks, system: layers.system,
      file: layers.file, fields: layers.fields,
    };
  }

  /**
   * An agent answers the ask: it runs headless with the ask written into the ask's folder, and draws through lolPing's
   * bridge, which calls agentTools and agentCall. Its exit ends the ask.
   */
  private async askAgent(run: Run, profile: AgentProfile, routeText: string, reading: Reading): Promise<void> {
    const { agents } = this.deps;
    const words = strings(run.lang).teammate.ask;
    run.profile = profile;
    run.route = routeText;
    // The profile's own time limit replaces the built-in client's.
    for (const d of run.deadlines) clearTimeout(d);
    run.deadlines = [];
    // An agent that answered and works on (editing files, or a child holding its output open) keeps its answer:
    // finish() stops it, as fail() would.
    this.deadline(run, profile.timeoutS * 1000, () => {
      if (!drew(run)) return this.fail(run, 'timeout');
      this.finish(run).catch((err: unknown) => console.warn('[teammate] ask failed:', err));
    });
    const token = `${run.machine.id}.${randomBytes(ASK_SECRET_BYTES).toString('hex')}`;
    const bridge = agents?.bridge.command(token) ?? null;
    if (!agents || !bridge) return this.fail(run, 'agentStart', words.agent.noBridge);
    if (!run.display) return this.fail(run, 'capture');
    run.machine.startGathering();

    const scene = await reading.scene();
    if (!scene || !this.alive(run)) return;
    const ctx = this.useScene(run, scene);
    const { cap } = scene;
    // dsh resumes a session only in the folder it was recorded in.
    const resume = run.thread?.agent?.profileId === profile.id ? run.thread.agent : null;
    const folder = agentFolder(profile, { app: run.app, title: run.title }, agents, run.lang);
    const cwd = resume?.cwd ?? folder.path;
    run.cwd = cwd;
    run.folder = resume ? words.folder(baseName(resume.cwd)) : folder.label;
    const images = { overview: baseName(cap.overviewPath), zooms: cap.zooms.map((z) => baseName(z.path)) };
    await this.files.write(join(run.dir, 'ask.md'), agentAsk(ctx, images));
    await this.files.write(join(run.dir, 'ask.json'), JSON.stringify({
      intent: run.intent.def.id, words: run.words, app: run.app, title: run.title, spots: ctx.spots,
      file: ctx.file?.doc.name ?? null, selection: ctx.system?.selection ?? '',
    }));
    if (!this.alive(run)) return;
    run.agent = { token, tools: [...toolsFor(run, ctx), ...(asksConsent(profile) ? [CONSENT_TOOL] : [])] };
    const spec: AgentRunSpec = {
      prompt: agentPrompt(run.dir), askDir: run.dir, bridge, resume: resume?.session ?? null,
      // dsh reads its patch as YAML; every other preset that takes a file reads JSON.
      mcpConfigPath: join(run.dir, profile.preset === 'dsh' ? 'mcp.yml' : 'mcp.json'),
    };
    run.machine.sent();

    let agentRun: AgentRun;
    try {
      const env = await agents.env();
      if (!this.alive(run)) return;
      agentRun = await agents.runner.start(profile, spec, cwd, env);
    } catch (err) {
      if (!(err instanceof AgentStartError) || !this.alive(run)) throw err;
      const { command } = profile;
      const line = err.kind === 'notFound' ? words.agent.notFound(command)
        : err.kind === 'noFolder' ? words.agent.noFolder(baseName(cwd)) : words.agent.noStart(command);
      return this.fail(run, 'agentStart', line);
    }
    // A cancel, a new ask, Stop, a deadline or a failure ends the agent and everything it started.
    if (!this.alive(run)) return agentRun.kill();
    run.agentRun = agentRun;
    run.abort.signal.addEventListener('abort', () => agentRun.kill(), { once: true });
    const name = profile.preset === 'custom' ? profile.name : AGENT_PRESETS[profile.preset].name;
    // Spec §16: an agent lists the tools about 2 s after it starts. One with its own MCP settings may lack lolPing.
    this.deadline(run, RECEIVE_MS, () => {
      if (run.machine.phase !== 'sent') return;
      const preset = profile.preset === 'custom' ? null : AGENT_PRESETS[profile.preset];
      const where = preset?.mcp === 'user' ? words.agent.addLolPing(preset.userConfig ?? null) : '';
      this.fail(run, 'notReceived', words.agent.notConnected(name) + where);
    });

    const result = await agentRun.done;
    if (!this.alive(run)) return;
    if (!drew(run)) {
      const error = result.error?.trim() ?? '';
      return this.fail(run, 'agent', error
        ? words.agent.error(name, error.slice(0, AGENT_ERROR_MAX)) : words.agent.stopped(name));
    }
    this.keepSession(run, result.session);
    await this.finish(run);
  }

  /** The agent's session, for the thread to resume; the first one kept stays (the exit's, else the latest printed). */
  private keepSession(run: Run, session: string | null): void {
    if (run.session || !isSessionId(session) || run.profile?.kind !== 'agent' || run.cwd === null) return;
    run.session = { profileId: run.profile.id, session, cwd: run.cwd };
  }

  /** The running ask an agent's bridge names by its token, if it is still going. */
  private agentRun(ask: string): Run | null {
    const run = this.run;
    return run && this.alive(run) && run.agent?.token === ask ? run : null;
  }

  private handlers(run: Run): StreamHandlers {
    return {
      accepted: () => {
        if (this.alive(run)) this.received(run);
      },
      text: () => undefined,
      // The line goes up as soon as its call is complete, not after the whole card answer behind it.
      call: (raw) => {
        if (raw.name !== 'say' || !this.alive(run)) return;
        const c = parseToolCall(raw.name, raw.args);
        if (c?.tool !== 'say') return;
        this.received(run);
        run.early.push(c.text);
        this.say(run, c.text);
      },
      usage: (u) => {
        // Tokens are spent even when the ask was cancelled, so they always count.
        this.deps.usage(u);
        run.tokens = (run.tokens ?? 0) + u.input + u.output;
      },
    };
  }

  /**
   * A deadline fails the ask with its own reason when it fires, unless the ask is over. Timers run on libuv's cached
   * loop time, which can be a few ms behind now(), so re-checking the clock here (machine.tick) could find the
   * deadline not yet due and never fire.
   */
  private deadline(run: Run, ms: number, onDue: () => void): void {
    run.deadlines.push(this.timer(ms, () => {
      if (this.alive(run)) onDue();
    }));
  }

  /** A timer whose callback can't throw into the main process. */
  private timer(ms: number, fn: () => void): Timer {
    return setTimeout(() => {
      try {
        fn();
      } catch (err) {
        console.warn('[teammate]', err);
      }
    }, ms);
  }

  private exclude(on: boolean): void {
    for (const target of [this.deps.overlay, this.deps.windows]) {
      try {
        target.setCaptureExcluded(on);
      } catch (err) {
        console.warn('[teammate] capture exclusion:', err);
      }
    }
  }

  /**
   * Overlays and teammate windows stay out of the grab; a count, so an older ask's capture can't let them back in.
   * Without a framing the overview is the whole display and each close-up a fixed crop around its spot.
   */
  private async capture(
    to: { rect: Rect | undefined; dir: string; signal: AbortSignal }, spots: Point[],
    framing?: { area: Rect; crops: Rect[] },
  ): Promise<Capture> {
    const { rect, dir, signal } = to;
    if (!rect) throw new ContextError('capture', 'no display under the spot');
    const release = this.deps.captureLease?.();
    try {
      this.excluded += 1;
      if (!release && this.excluded === 1) this.exclude(true);
      await this.files.makeDir(dir);
      return await this.deps.context.capture({ display: rect, spots, dir, ...framing }, signal);
    } finally {
      this.excluded -= 1;
      if (!release && this.excluded === 0) this.exclude(false);
      release?.();
    }
  }

  /** The teammate's On My Way next to the user's ping, kept until the answer is over. */
  private received(run: Run): void {
    if (!run.machine.received()) return;
    const at = this.deps.overlay.toLocal(run.receipt);
    if (!at) return;
    const t = this.deps.settings().teammate;
    // For a Do it ask the user's own ping is already On My Way: the receipt is the tag with its dots alone.
    const tagOnly = run.spot.intent === 'omw' ? { tagOnly: true } : {};
    this.deps.overlay.spawnMate({
      ...at, id: 'omw', thinking: true, keep: true, silent: !t.receiptSound, tag: run.tag, ...tagOnly,
    });
    this.marksShown = true;
    this.watchShown(run);
  }

  /** Draws one round of tool calls and says what each one did, for the model's next round. */
  private async play(
    run: Run,
    raws: RawCall[],
    offered: ReadonlySet<string>,
    lastRound: boolean,
  ): Promise<{ again: boolean; results: { id: string; content: Part[] }[] }> {
    const parsed = raws.map((raw) => ({ raw, call: parseToolCall(raw.name, raw.args) }));
    for (const p of parsed) if (p.call) run.calls.push(p.call);
    const kept = new Set(applyLimits(run.calls));
    const results = new Map<RawCall, Part[]>();
    const valid: { raw: RawCall; call: ToolCall }[] = [];
    let again = false;
    for (const { raw, call } of parsed) {
      if (!offered.has(raw.name)) {
        results.set(raw, NOT_AVAILABLE);
        again = true;
      } else if (!call) {
        results.set(raw, INVALID);
      } else if (!kept.has(call)) {
        results.set(raw, OVER_LIMIT);
      } else {
        results.set(raw, isAction(call) && call.tool !== 'copy' ? ASKED : DONE);
        valid.push({ raw, call });
      }
    }

    // The line comes first whatever order the model used, then the card, then the marks.
    for (const { call } of valid) {
      if (call.tool !== 'say') continue;
      const shown = run.early.indexOf(call.text);
      if (shown >= 0) run.early.splice(shown, 1);
      else this.say(run, call.text);
    }
    for (const { call } of valid) if (call.tool === 'answer') this.addAnswer(run, call.markdown);
    const pings = valid.flatMap(({ call }) => (call.tool === 'ping' ? [call] : []));
    pings.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    for (const p of pings) this.placePing(run, p);
    for (const { call } of valid) if (call.tool === 'emote') this.placeEmote(run, call);
    for (const { call } of valid) if (isAction(call)) this.takeAction(run, call);
    for (const { raw, call } of valid) {
      if (call.tool !== 'read_file') continue;
      // Like look: no round follows the last one to read what it gives.
      if (lastRound || !run.doc) {
        results.set(raw, NOT_AVAILABLE);
        continue;
      }
      again = true;
      const read = readFileTool(run.doc, call, run.fileRead, FILE_READ_LIMIT);
      run.fileRead = read.served;
      results.set(raw, [{ text: read.text }]);
    }
    for (const { raw, call } of valid) {
      if (call.tool !== 'look') continue;
      // No round follows the last one to read a look, so don't capture for it.
      if (lastRound) {
        results.set(raw, NOT_AVAILABLE);
        continue;
      }
      again = true;
      results.set(raw, await this.look(run, call));
      if (!this.alive(run)) break;
    }
    return { again, results: raws.map((raw) => ({ id: raw.id, content: results.get(raw) ?? DONE })) };
  }

  private takeAction(run: Run, call: ActionCall): void {
    this.deps.actions?.take(this.runInfo(run), call);
  }

  private runInfo(run: Run): RunInfo {
    const focus = run.system?.focus ?? null;
    run.info ??= {
      id: run.machine.id, profileId: run.profile?.id ?? '', profileName: run.profile?.name ?? '', tag: run.tag,
      app: run.app, window: run.window, lang: run.lang, spot: run.spot.phys,
      at: this.deps.overlay.toDip(run.spot.phys) ?? this.deps.overlay.primaryDip(),
      box: run.box,
      focus: focus ? { kind: focus.kind, label: focus.label, value: focus.value, secure: focus.secure } : null,
      selection: run.system?.selection ?? '', fields: run.fields, cwd: run.cwd,
    };
    return run.info;
  }

  private async look(run: Run, area: { x: number; y: number; w: number; h: number }): Promise<Part[]> {
    const centre = run.shot ? overviewToPhysical(run.shot, { x: area.x + area.w / 2, y: area.y + area.h / 2 }) : null;
    if (!centre) return [{ text: 'That area is outside the screen.' }];
    try {
      const cap = await this.capture({ rect: run.display?.rect, dir: run.dir, signal: run.abort.signal }, [centre]);
      const zoom = cap.zooms[0];
      if (!zoom) return [{ text: 'Could not look closer.' }];
      const data = await this.files.read(zoom.path);
      if (data.length === 0) return [{ text: 'Could not look closer.' }];
      const cx = Math.round(area.x + area.w / 2);
      const cy = Math.round(area.y + area.h / 2);
      return [
        { text: `A full-resolution view around x=${cx}, y=${cy} of the overview.` },
        { image: { mime: 'image/jpeg', data } },
      ];
    } catch {
      return [{ text: 'Could not look closer.' }];
    }
  }

  private target(run: Run, at: Target): Point | null {
    if (run.visitor) return run.visitor.point;
    // The model numbers the user's spots from 1; a pixel point snaps onto the control or text line under it.
    const spots = run.spots.map((s) => s.phys);
    return run.shot ? resolveTarget(at, { spots, marks: run.screenMarks, shot: run.shot }) : null;
  }

  private placePing(run: Run, c: Extract<ToolCall, { tool: 'ping' }>): void {
    if (run.stale) return;
    const point = this.target(run, c.at);
    const at = point ? this.deps.overlay.toLocal(point) : null;
    if (!point || !at) return;
    run.marks.push(point);
    const ping = {
      ...at, id: c.type, keep: true, tag: run.tag,
      ...(c.label ? { label: c.label } : {}),
      ...(run.pings > 0 ? { silent: true } : {}), // one sound for the whole set
    };
    run.pings += 1;
    const now = this.deps.now();
    const when = Math.max(now, this.nextPingAt);
    this.nextPingAt = when + PING_GAP_MS;
    const show = () => {
      if (run.stale) return;
      this.deps.overlay.spawnMate(ping);
      this.marksShown = true;
      this.watchShown(run);
    };
    if (when <= now) {
      show();
      return;
    }
    const timer = this.timer(when - now, () => {
      this.pingTimers.delete(timer);
      show();
    });
    this.pingTimers.add(timer);
  }

  private placeEmote(run: Run, c: Extract<ToolCall, { tool: 'emote' }>): void {
    if (run.stale) return;
    const point = this.target(run, c.at);
    const at = point ? this.deps.overlay.toLocal(point) : null;
    if (!point || !at) return;
    run.marks.push(point);
    this.deps.overlay.spawnMateEmote({ ...at, slug: c.slug, keep: true, tag: run.tag });
    this.marksShown = true;
    this.watchShown(run);
  }

  private say(run: Run, text: string): void {
    if (run.line) {
      run.markdown.push(text);
      // The page moved and its line faded, but the user still wants the answer: the line comes back with it.
      if (run.bubbleBack && !this.bubbleShown && !this.cardShown) this.showLine(run, run.line);
      else this.refresh(run);
      return;
    }
    const { line, rest } = splitLine(text, run.lang);
    run.line = line;
    run.rest = rest;
    run.said = rest ? text.trim() : line;
    this.deps.overlay.mateSaid();
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, this.alive(run)));
    else this.showLine(run, line);
  }

  private addAnswer(run: Run, markdown: string): void {
    run.markdown.push(markdown);
    if (run.autoCard && !this.cardShown) this.openCard(run);
    else this.refresh(run);
  }

  /** The card, or the bubble's More button, catches up with what the answer has so far. */
  private refresh(run: Run): void {
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, this.alive(run)));
    else if (this.bubbleShown) this.deps.windows.updateBubble(this.bubbleState(run, run.line));
  }

  private async finish(run: Run): Promise<void> {
    // An agent still running when its time ran out has printed its session already.
    this.keepSession(run, run.agentRun?.session() ?? null);
    if (!run.line && run.text.trim()) this.say(run, run.text);
    // A model that skipped `say` is not asked again, which would cost a whole round: the card's start is the line.
    // The card keeps no copy of it above the answer it came from.
    if (!run.line && run.markdown.length > 0) {
      run.line = lineFromMarkdown(run.markdown.join('\n\n'), run.lang);
      if (run.line) {
        this.deps.overlay.mateSaid();
        if (!run.autoCard && !this.cardShown) this.showLine(run, run.line);
      }
    }
    if (!run.line && run.markdown.length === 0 && run.marks.length === 0) return this.fail(run, 'other');
    if (!run.line) {
      this.deps.overlay.mateSaid(); // the thinking is over even without a line
      // Only an answer for the card: the bubble shows just its More button.
      if (run.markdown.length > 0 && !run.autoCard && !this.cardShown) this.showLine(run, '');
    }
    run.machine.done();
    this.stopRun();
    // A line whose time ran out while the answer was still coming gets its time again from now.
    if (this.bubbleShown && this.bubbleTimer === null) this.armBubble(run, run.line);
    if (run.autoCard && !this.cardShown) this.openCard(run);
    else if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, false));
    this.answeredAt = this.deps.now();
    this.scheduleFade();
    // What the actions did, never what they put anywhere (spec §8.2).
    const done = this.deps.actions?.described() ?? [];
    const entry = {
      at: this.deps.now(), intent: run.spot.intent, words: run.words, line: run.said,
      markdown: run.markdown.join('\n\n'), thumb: run.thumb, ...(done.length > 0 ? { done } : {}),
      spots: run.spots.length,
    };
    const agent = run.session ? { agent: run.session } : {};
    const meta = {
      title: (run.line || run.intent.label).slice(0, TITLE_MAX), app: run.app, windowTitle: run.title,
      profile: run.profile?.name ?? '', ...agent,
    };
    // The thread is kept here first, so it continues even when history is off and append saves nothing.
    const now = this.deps.now();
    const local: ThreadRecord = run.thread
      ? { ...run.thread, lastActivity: now, entries: [...run.thread.entries, entry], ...agent }
      : { id: randomUUID(), ...meta, started: now, lastActivity: now, entries: [entry] };
    this.thread = local;
    const saving = this.deps.history.append(run.thread?.id ?? null, entry, meta).catch(() => null);
    this.entry = { ask: run.machine.id, at: entry.at, thread: saving.then((s) => s?.id ?? null) };
    const saved = await saving;
    // A saved record replaces ours only when it is the same thread: with history off, append makes a new one each time.
    if (saved && this.thread === local && (run.thread === null || saved.id === run.thread.id)) this.thread = saved;
  }

  /**
   * The put button changed, or a paste didn't land and the button stays. The card or the bubble shows it; when neither
   * is up because the runner hid it for the paste, the bubble comes back with it.
   */
  private showPut(state: PutState): void {
    this.put = state;
    const run = this.shown;
    if (!run) return;
    if (this.cardShown) {
      this.deps.windows.updateCard(this.cardState(run, this.alive(run)));
    } else if (this.bubbleShown) {
      this.deps.windows.updateBubble(this.bubbleState(run, run.line));
      // A button that just came deserves the line's whole reading time, not what was left of it.
      if (state !== null) this.armBubble(run, run.line);
    } else if (state !== null && this.hiddenForPut === run) {
      this.showLine(run, run.line);
    }
  }

  /** An action of the last answer was done after its entry went into history: the entry says so too. */
  private amendDone(ask: string, done: string[]): void {
    const entry = this.entry;
    if (entry?.ask !== ask) return; // still answering: finish() takes it from described()
    entry.thread
      .then((id) => (id === null ? undefined : this.deps.history.amend(id, entry.at, done)))
      .catch((err: unknown) => console.warn('[teammate] history:', err));
  }

  /** `line`: what the bubble says when the reason's own words can't say it (an agent's error, its command). */
  private fail(run: Run, reason: AskFailure, line?: string): void {
    run.machine.fail(reason);
    this.stopRun();
    this.clearMarks();
    const at = run.stale ? null : this.deps.overlay.toLocal(run.receipt);
    if (at) {
      this.deps.overlay.spawnMate({ ...at, id: 'missing', keep: true, tag: run.tag });
      this.marksShown = true;
      this.watchShown(run);
    }
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, false));
    this.showLine(run, line ?? strings(run.lang).teammate.ask.failed[reason]);
    this.answeredAt = this.deps.now();
    this.scheduleFade();
  }

  /** Ends the running ask, if any: its requests are aborted and its deadlines dropped. */
  private stopRun(): void {
    const run = this.run;
    if (!run) return;
    run.ended = true;
    run.machine.cancel(); // no-op once the ask is done or failed
    run.abort.abort();
    for (const d of run.deadlines) clearTimeout(d);
    this.run = null;
    this.emit('state', false);
  }

  private showLine(run: Run, line: string): void {
    this.hiddenForPut = null;
    run.bubbleBack = false;
    const state = this.bubbleState(run, line);
    if (this.bubbleShown) this.deps.windows.updateBubble(state);
    else this.deps.windows.showBubble(this.popupAt(run), state);
    this.bubbleShown = true;
    this.watchShown(run);
    this.armBubble(run, line);
  }

  /** The line's time on screen. While its answer is still coming the line stays, and finish() starts its time again. */
  private armBubble(run: Run, line: string): void {
    this.clearTimer('bubble');
    if (this.asking) return; // onAsking(false) starts its time
    const ms = bubbleMs(line);
    this.bubbleEndsAt = this.deps.now() + ms;
    this.bubbleTimer = this.timer(ms, () => {
      this.bubbleTimer = null;
      if (!this.alive(run)) this.hideBubble();
    });
  }

  private bubbleState(run: Run, line: string): BubbleState {
    return {
      view: 'bubble', lang: run.lang, tag: run.tag, line, thread: run.thread?.title ?? null, thinking: false,
      // An answer's line always offers More, if only for the card's reply box; a failure's line doesn't.
      more: run.rest !== '' || run.markdown.length > 0 || (line !== '' && run.machine.failure === null),
      put: run.visitor ? null : this.put,
    };
  }

  /** `focus`: the user asked for it (More), so it takes the keyboard. */
  private openCard(run: Run, focus = false): void {
    // The card grows out of the bubble, which goes; where the user dragged the bubble, the card opens.
    const at = this.deps.windows.placeOf('bubble') ?? this.popupAt(run);
    this.hideBubble();
    this.deps.windows.showCard(at, this.cardState(run, this.alive(run)), { focus });
    this.cardShown = true;
    this.clearTimer('fade'); // the marks stay while the card is up; closing it schedules their fade
  }

  private cardState(run: Run, streaming: boolean): CardState {
    const t = strings(run.lang).teammate;
    const entries = run.thread ? this.threadEntries(run.thread, run.lang, run.tag.name) : [];
    const label = askLabel(run.intent.label, run.spots.length, run.lang);
    const pair = entryPair(label, run.words, run.said, run.markdown.join('\n\n'), run.tag.name);
    // An agent's card has no ask above its answer: nobody asked.
    entries.push(...(run.visitor ? pair.slice(1) : pair));
    return {
      view: 'card', lang: run.lang, tag: run.tag, entries, streaming,
      title: run.thread?.title ?? (run.line || (run.visitor ? run.tag.name : run.intent.label)).slice(0, TITLE_MAX),
      footer: {
        profile: run.profile?.name ?? '', model: run.profile?.kind === 'builtin' ? run.profile.model : '',
        route: run.route, tokens: run.tokens,
        used: run.visitor ? [] : [
          t.ask.usedScreen,
          ...run.used.map((u) => usedLabel(u, run.lang)),
          ...(run.skipped ? [t.ask.contextSkipped] : []),
          ...(run.folder ? [run.folder] : []),
        ],
      },
      put: run.visitor ? null : this.put,
      ...(run.visitor ? { answerOnly: true } : {}),
    };
  }

  private threadEntries(thread: ThreadRecord, lang: Lang, tagName: string): CardState['entries'] {
    const s = this.deps.settings().teammate;
    return thread.entries.flatMap((e) =>
      entryPair(askLabel(intentFor(s, e.intent, lang).label, e.spots, lang), e.words, e.line, e.markdown, tagName));
  }

  private popupAt(run: Run): Point {
    const dip = this.deps.overlay.toDip(run.receipt);
    return dip ? { x: dip.x + BUBBLE_OFFSET.x, y: dip.y + BUBBLE_OFFSET.y } : this.deps.overlay.primaryDip();
  }

  /**
   * The teammate's marks fade once the bubble is gone and the card is closed, and never sooner than MARKS_MIN_MS
   * after the answer (nor before the last ping has been drawn). A card that opens or closes later calls this again.
   */
  private scheduleFade(): void {
    this.clearTimer('fade');
    if (this.answeredAt === null || this.cardShown) return;
    const now = this.deps.now();
    const lastPingAt = this.nextPingAt > 0 ? this.nextPingAt - PING_GAP_MS : 0;
    const at = Math.max(this.bubbleEndsAt, this.answeredAt + MARKS_MIN_MS, lastPingAt);
    this.fadeTimer = this.timer(Math.max(0, at - now), () => {
      this.fadeTimer = null;
      this.answeredAt = null;
      if (!this.marksShown) return;
      this.deps.overlay.fadeMate();
      this.marksShown = false;
      this.watchGone();
    });
  }

  private clearMarks(): void {
    for (const timer of this.pingTimers) clearTimeout(timer);
    this.pingTimers.clear();
    if (!this.marksShown) return;
    this.deps.overlay.clearMate();
    this.marksShown = false;
    this.watchGone();
  }

  /**
   * Any hide but the runner's own (a dismiss, the line's time, a new ask, a pause) keeps the bubble from coming back.
   * `now`: without the leave motion; `stale`: the slow fade of a page that moved.
   */
  private hideBubble(how: 'fast' | 'now' | 'stale' = 'fast'): void {
    this.hiddenForPut = null;
    if (how !== 'stale' && this.shown) this.shown.bubbleBack = false;
    this.clearTimer('bubble');
    this.bubbleEndsAt = 0;
    if (!this.bubbleShown) return;
    if (how === 'now') this.deps.windows.hideNow('bubble');
    else if (how === 'stale') this.deps.windows.hideBubble({ stale: true });
    else this.deps.windows.hideBubble();
    this.bubbleShown = false;
    this.watchGone();
  }

  /** `run`'s mark or bubble came up: the stale watch follows it, from its own window. */
  private watchShown(run: Run): void {
    if (run.stale || this.watched === run) return;
    this.watched = run;
    this.emit('watch', { window: run.window });
  }

  /** Nothing of the teammate's that the page can leave behind is up: the watch ends. */
  private watchGone(): void {
    if (this.marksShown || this.bubbleShown || this.watched === null) return;
    this.watched = null;
    this.emit('watch', null);
  }

  private hideCard(): void {
    this.hiddenForPut = null;
    if (this.shown) this.shown.bubbleBack = false; // the user closed the answer: a later say doesn't reopen it
    if (!this.cardShown) return;
    this.deps.windows.hideCard();
    this.cardShown = false;
    if (this.marksShown) this.scheduleFade();
  }

  private clearTimer(which: 'bubble' | 'fade'): void {
    const timer = which === 'bubble' ? this.bubbleTimer : this.fadeTimer;
    if (timer) clearTimeout(timer);
    if (which === 'bubble') this.bubbleTimer = null;
    else this.fadeTimer = null;
  }
}
