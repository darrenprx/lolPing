import type { Point } from '../ipc';
import type { Rect } from './coords';
import { FIELD_ID_MAX, neverFill, type FormField } from './doRules';

/** The overview's long side, its JPEG quality and the zoom crop size (spec §6.1). */
export const OVERVIEW_LONG_SIDE = 1600;
export const JPEG_QUALITY = 80;
export const ZOOM_SIZE = { w: 1000, h: 750 };

/** Lines main writes to context-helper's stdin: flat JSON, lists as strings, like the hook helper's commands. */
export type ContextCommand =
  | {
    type: 'capture'; id: string; display: string; area?: string; spots: string; crops?: string; overview: number;
    zoom: string; quality: number; dir: string;
  }
  | {
    type: 'read'; id: string; spots: string; radius: number; marks: boolean; text: boolean; file: boolean;
    boxes: boolean; fields: boolean; dir: string;
  }
  | { type: 'foreground'; id: string }
  | { type: 'front'; id: string }
  | {
    type: 'paste'; id: string; window: string; text: string; click: string; field: string; mode: 'insert' | 'replace';
    asked: string;
  }
  | { type: 'setField'; id: string; window: string; field: string; value: string }
  | { type: 'ping'; id: string }
  | { type: 'shutdown' };

/**
 * What a paste did: `ok` pasted; the rest pasted nothing and left the clipboard as it was. `window`: another window is
 * in front (or the click would land in one); `hung`: the app doesn't answer; `selection`: a replace's selection no
 * longer holds the asked text; `secure`: a password or never-fill field; `hands`: a key or button stayed held for 3 s;
 * `busy`: the clipboard or the input could not be used, or too little time was left; `elevated`: the app runs as
 * administrator, where Windows drops lolPing's input without a word.
 */
export type PasteResult = 'ok' | 'hung' | 'window' | 'hands' | 'selection' | 'secure' | 'busy' | 'elevated';

/** What a setField did: `gone`: no such field in the window; `refused`: the field didn't take the value. */
export type SetFieldResult = 'ok' | 'gone' | 'refused' | 'secure' | 'window' | 'hung';

/**
 * A paste into the ask's window. `click` puts the caret in the field first (insert only: a click would drop the
 * selection a replace pastes over); `asked` is the selection the ask saw, which a replace must still find.
 */
export interface PasteRequest {
  window: string;
  text: string;
  click: Point | null;
  /** The form field a click must land on (FormField.id); without it the helper wants any text field there. */
  field?: string;
  mode: 'insert' | 'replace';
  asked: string;
}

/** A form field's new value; checkboxes and radios take 'on' or 'off'. */
export interface SetFieldRequest {
  window: string;
  field: string;
  value: string;
}

export type ContextErrorCode = 'capture' | 'permission' | 'bad';

/** One layer of a read: `off` was not asked for; `slow` was still running at the budget, so the helper exits. */
export type LayerStatus = 'off' | 'ok' | 'slow' | 'capture' | 'permission';

/** How the helper found the file behind the window. */
export type FileHow = 'office' | 'address' | 'title' | 'none';

/** What the system says is selected, under the spots and in focus. A secure or never-fill field gives no value and no
 *  selection. */
export interface SystemTextLayer {
  selection: string;
  spotTexts: string[];
  focus: { kind: string; label: string; value: string; secure: boolean } | null;
  address: string;
}

/** What one read found; a layer is null unless its status is `ok`. */
export interface ReadResult {
  status: { marks: LayerStatus; text: LayerStatus; file: LayerStatus; boxes: LayerStatus; fields: LayerStatus };
  marks: { path: string; count: number } | null;
  text: SystemTextLayer | null;
  file: { path: string; address: string; how: FileHow } | null;
  /** Per spot, the boxes that hold the element under it, innermost first, ending with its window. */
  boxes: Rect[][] | null;
  /** The form fields in the window, in a JSON-lines file (see parseFieldsFile). */
  fields: { path: string; count: number } | null;
}

/** Lines context-helper writes to stdout, after validation. */
export type ContextReply =
  | { type: 'captured'; id: string; overview: string; ow: number; oh: number; zooms: { path: string; rect: Rect }[] }
  | ({ type: 'read'; id: string } & ReadResult)
  /** `window` is the window's id (the HWND in decimal on Windows), or '' where the helper has none; `pid` its process. */
  | { type: 'foreground'; id: string; app: string; title: string; window: string; pid: number }
  /** The window in front, read without calling into its app; no window and a zero box when nothing is in front. */
  | {
    type: 'front'; id: string; window: string; title: string; x: number; y: number; w: number; h: number; pid: number;
  }
  /** `restored`: false when the user's clipboard could not be put back after the paste (true when left out). */
  | { type: 'pasted'; id: string; result: PasteResult; restored: boolean }
  | { type: 'set'; id: string; result: SetFieldResult }
  | { type: 'pong'; id: string }
  | { type: 'error'; id: string; code: ContextErrorCode; message: string };

const rectText = (r: Rect): string => [r.x, r.y, r.w, r.h].map(Math.round).join(',');
const spotsText = (spots: readonly Point[]): string => (
  spots.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')
);

/**
 * The capture command for one ask: the helper wants whole pixels. The overview shows `area` (the whole display when
 * left out); each spot's close-up is its crop, or a fixed-size one around it.
 */
export function captureCommand(
  id: string,
  req: { display: Rect; area?: Rect; spots: { x: number; y: number }[]; crops?: Rect[]; dir: string; overview?: number },
): ContextCommand {
  return {
    type: 'capture',
    id,
    display: rectText(req.display),
    ...(req.area ? { area: rectText(req.area) } : {}),
    spots: spotsText(req.spots),
    ...(req.crops ? { crops: req.crops.map(rectText).join(';') } : {}),
    overview: req.overview ?? OVERVIEW_LONG_SIDE,
    zoom: `${ZOOM_SIZE.w},${ZOOM_SIZE.h}`,
    quality: JPEG_QUALITY,
    dir: req.dir,
  };
}

/**
 * Reads the layers that are on, side by side: the boxes around the element under each spot, the controls and text
 * near the spots (into a marks file in `dir`), the system text, the file behind the window and the form fields
 * (into a fields file in `dir`).
 */
export function readCommand(
  id: string,
  req: {
    spots: Point[]; radius: number; marks: boolean; text: boolean; file: boolean; boxes: boolean; fields: boolean;
    dir: string;
  },
): ContextCommand {
  return {
    type: 'read', id, spots: spotsText(req.spots), radius: Math.round(req.radius), marks: req.marks, text: req.text,
    file: req.file, boxes: req.boxes, fields: req.fields, dir: req.dir,
  };
}

/**
 * `text` without what JSON.stringify writes as an escape the helper's flat parser doesn't read (\b, \f, \u00XX, a lone
 * surrogate as \uDXXX), so a paste never fails on a stray control character. Tabs and line breaks stay.
 */
const helperText = (text: string): string => text.replace(
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
  '',
);

export function pasteCommand(id: string, req: PasteRequest): ContextCommand {
  return {
    type: 'paste',
    id,
    window: req.window,
    text: helperText(req.text),
    click: req.click ? `${Math.round(req.click.x)},${Math.round(req.click.y)}` : '',
    field: req.field ?? '',
    mode: req.mode,
    asked: helperText(req.asked),
  };
}

export function setFieldCommand(id: string, req: SetFieldRequest): ContextCommand {
  return { type: 'setField', id, window: req.window, field: req.field, value: helperText(req.value) };
}

export const serializeContextCommand = (cmd: ContextCommand): string => `${JSON.stringify(cmd)}\n`;

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isErrorCode = (v: unknown): v is ContextErrorCode => v === 'capture' || v === 'permission' || v === 'bad';
const isLayerStatus = (v: unknown): v is LayerStatus => (
  v === 'off' || v === 'ok' || v === 'slow' || v === 'capture' || v === 'permission'
);
const isFileHow = (v: unknown): v is FileHow => v === 'office' || v === 'address' || v === 'title' || v === 'none';
const PASTE_RESULTS: readonly PasteResult[] = [
  'ok', 'hung', 'window', 'hands', 'selection', 'secure', 'busy', 'elevated',
];
const SET_FIELD_RESULTS: readonly SetFieldResult[] = ['ok', 'gone', 'refused', 'secure', 'window', 'hung'];
const isPasteResult = (v: unknown): v is PasteResult => PASTE_RESULTS.includes(v as PasteResult);
const isSetFieldResult = (v: unknown): v is SetFieldResult => SET_FIELD_RESULTS.includes(v as SetFieldResult);

/** Between spot texts in the read reply. */
const RECORD_SEPARATOR = '\u001e';

/** The helper's caps (kSelectionMax and the rest in context.h), applied again here in case a helper ever doesn't. A
 *  selection this long in code points may have been cut. */
export const SELECTION_MAX = 4000;
const SPOT_TEXT_MAX = 2000;
const FOCUS_VALUE_MAX = 2000;
const ADDRESS_MAX = 2000;

/** The helper's caps on the form fields file (kMaxFormFields and the rest in context.h), applied again here. */
const FIELDS_MAX = 60;
const FIELD_LABEL_MAX = 120;
const FIELD_VALUE_MAX = 2000;
const FIELD_OPTIONS_MAX = 50;
const FIELD_OPTION_MAX = 120;
const FIELD_KINDS: readonly FormField['kind'][] = ['text', 'multiline', 'combo', 'checkbox', 'radio', 'other'];

/** The first `max` code points of `text`. */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let at = 0;
  let n = 0;
  for (const ch of text) {
    if (n === max) return text.slice(0, at);
    at += ch.length;
    n += 1;
  }
  return text;
}

function parseSystemText(o: Record<string, unknown>): SystemTextLayer | null {
  const { selection, spotTexts, focusKind, focusLabel, focusValue, focusSecure, address } = o;
  if (typeof selection !== 'string' || typeof spotTexts !== 'string' || typeof focusKind !== 'string') return null;
  if (typeof focusLabel !== 'string' || typeof focusValue !== 'string' || typeof address !== 'string') return null;
  if (typeof focusSecure !== 'boolean') return null;
  // The helper already sends no value or selection for a secure or never-fill field; blanking them here keeps that true
  // whatever arrives. The selection is read from the focused field. Only a field's label counts: a page's is its title.
  const secure = focusSecure || (focusKind === 'field' && neverFill({ label: focusLabel, secure: false }));
  return {
    selection: secure ? '' : capChars(selection, SELECTION_MAX),
    spotTexts: spotTexts === '' ? [] : spotTexts.split(RECORD_SEPARATOR).map((t) => capChars(t, SPOT_TEXT_MAX)),
    focus: focusKind === '' ? null : {
      kind: focusKind, label: focusLabel, value: secure ? '' : capChars(focusValue, FOCUS_VALUE_MAX), secure,
    },
    address: capChars(address, ADDRESS_MAX),
  };
}

function parseField(v: unknown): FormField | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const { id, kind, label, group, value, secure, required, options, box } = o;
  // A cut id would name another field, or none: a field whose id is too long is skipped.
  if (typeof id !== 'string' || id === '' || id.length > FIELD_ID_MAX || typeof kind !== 'string') return null;
  if (!FIELD_KINDS.includes(kind as FormField['kind'])) return null;
  if (typeof label !== 'string' || typeof group !== 'string' || typeof value !== 'string') return null;
  if (typeof secure !== 'boolean' || typeof required !== 'boolean' || !Array.isArray(options)) return null;
  if (!options.every((opt) => typeof opt === 'string')) return null;
  // Without a box a field is still filled; it only gets no ping and no paste fallback.
  const rect = typeof box === 'string' ? parseRect(box) : null;
  return {
    id,
    kind: kind as FormField['kind'],
    label: capChars(label, FIELD_LABEL_MAX),
    group: capChars(group, FIELD_LABEL_MAX),
    // The helper already sends no value for a secure or never-fill field; blanking it here keeps that true whatever
    // arrives.
    value: neverFill({ label, secure }) ? '' : capChars(value, FIELD_VALUE_MAX),
    secure,
    required,
    options: (options as string[]).slice(0, FIELD_OPTIONS_MAX).map((opt) => capChars(opt, FIELD_OPTION_MAX)),
    ...(rect ? { box: rect } : {}),
  };
}

/**
 * The helper's fields file: one JSON object per line, one form field each. A line that is not a valid field is
 * skipped, as is a repeated id, and at most 60 fields are kept.
 */
export function parseFieldsFile(text: string): FormField[] {
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (out.length === FIELDS_MAX) break;
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const field = parseField(v);
    if (!field || seen.has(field.id)) continue;
    seen.add(field.id);
    out.push(field);
  }
  return out;
}

function parseRead(o: Record<string, unknown>): ReadResult | null {
  const { marks, text, file, boxes, fields } = o;
  if (!isLayerStatus(marks) || !isLayerStatus(text) || !isLayerStatus(file) || !isLayerStatus(boxes)) return null;
  if (!isLayerStatus(fields)) return null;
  let found: ReadResult['marks'] = null;
  if (marks === 'ok') {
    if (typeof o.marksPath !== 'string' || o.marksPath === '' || !isCount(o.count)) return null;
    found = { path: o.marksPath, count: o.count };
  }
  const layer = text === 'ok' ? parseSystemText(o) : null;
  if (text === 'ok' && !layer) return null;
  let behind: ReadResult['file'] = null;
  if (file === 'ok') {
    if (typeof o.filePath !== 'string' || typeof o.fileAddress !== 'string' || !isFileHow(o.how)) return null;
    behind = { path: o.filePath, address: o.fileAddress, how: o.how };
  }
  let chains: ReadResult['boxes'] = null;
  if (boxes === 'ok') {
    chains = typeof o.boxRects === 'string' ? parseBoxes(o.boxRects) : null;
    if (!chains) return null;
  }
  let form: ReadResult['fields'] = null;
  if (fields === 'ok') {
    if (typeof o.fieldsPath !== 'string' || o.fieldsPath === '' || !isCount(o.fieldCount)) return null;
    form = { path: o.fieldsPath, count: o.fieldCount };
  }
  return {
    status: { marks, text, file, boxes, fields }, marks: found, text: layer, file: behind, boxes: chains, fields: form,
  };
}

function parseRect(s: string): Rect | null {
  const parts = s.split(',');
  if (parts.length !== 4 || parts.some((p) => !/^-?\d+$/.test(p))) return null;
  const [x, y, w, h] = parts.map(Number);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Spots separated by ';', each spot's boxes by '|'; a spot with no boxes is empty. */
function parseBoxes(s: string): Rect[][] | null {
  const out: Rect[][] = [];
  for (const spot of s.split(';')) {
    const chain = spot === '' ? [] : spot.split('|').map(parseRect);
    if (chain.some((r) => r === null)) return null;
    out.push(chain.filter((r): r is Rect => r !== null));
  }
  return out;
}

function parseZooms(paths: string, rects: string): { path: string; rect: Rect }[] | null {
  if (paths === '' && rects === '') return [];
  const ps = paths.split(';');
  const rs = rects.split(';');
  if (ps.length !== rs.length || ps.some((p) => p === '')) return null;
  const out: { path: string; rect: Rect }[] = [];
  for (let i = 0; i < ps.length; i += 1) {
    const rect = parseRect(rs[i]);
    if (!rect) return null;
    out.push({ path: ps[i], rect });
  }
  return out;
}

/** One stdout line, validated from unknown; null for anything malformed. */
export function parseContextLine(line: string): ContextReply | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const id = o.id;
  switch (o.type) {
    case 'captured': {
      if (typeof o.overview !== 'string' || o.overview === '' || !isPositiveInt(o.ow) || !isPositiveInt(o.oh)) return null;
      if (typeof o.zooms !== 'string' || typeof o.zoomRects !== 'string') return null;
      const zooms = parseZooms(o.zooms, o.zoomRects);
      return zooms ? { type: 'captured', id, overview: o.overview, ow: o.ow, oh: o.oh, zooms } : null;
    }
    case 'read': {
      const result = parseRead(o);
      return result ? { type: 'read', id, ...result } : null;
    }
    case 'foreground':
      if (typeof o.app !== 'string' || typeof o.title !== 'string') return null;
      if (typeof o.window !== 'string' || !/^[0-9]*$/.test(o.window) || !isCount(o.pid)) return null;
      return { type: 'foreground', id, app: o.app, title: o.title, window: o.window, pid: o.pid };
    case 'front':
      if (typeof o.window !== 'string' || !/^[0-9]*$/.test(o.window) || typeof o.title !== 'string') return null;
      if (!isInt(o.x) || !isInt(o.y) || !isCount(o.w) || !isCount(o.h) || !isCount(o.pid)) return null;
      return {
        type: 'front', id, window: o.window, title: o.title, x: o.x, y: o.y, w: o.w, h: o.h, pid: o.pid,
      };
    case 'pasted':
      if (!isPasteResult(o.result) || (o.restored !== undefined && typeof o.restored !== 'boolean')) return null;
      return { type: 'pasted', id, result: o.result, restored: o.restored ?? true };
    case 'set':
      return isSetFieldResult(o.result) ? { type: 'set', id, result: o.result } : null;
    case 'pong':
      return { type: 'pong', id };
    case 'error':
      if (!isErrorCode(o.code) || typeof o.message !== 'string') return null;
      return { type: 'error', id, code: o.code, message: o.message };
    default:
      return null;
  }
}
