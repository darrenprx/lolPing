/** A tiny, safe markdown parser: turns model output into a plain data tree, never into HTML. */

export type MdSpan =
  | { t: 'text'; text: string }
  | { t: 'bold'; spans: MdSpan[] }
  | { t: 'italic'; spans: MdSpan[] }
  | { t: 'code'; text: string }
  | { t: 'link'; text: string };

export type MdBlock =
  | { t: 'p'; spans: MdSpan[] }
  | { t: 'heading'; level: number; spans: MdSpan[] }
  | { t: 'code'; text: string }
  | { t: 'list'; ordered: boolean; items: MdSpan[][] }
  | { t: 'quote'; lines: MdSpan[][] }
  | { t: 'hr' };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\n]+\))/g;

/** One pass of inline marks; links keep their text and lose their target (this window never navigates). */
export function parseSpans(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) spans.push({ t: 'text', text: text.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('`')) spans.push({ t: 'code', text: token.slice(1, -1) });
    else if (token.startsWith('**')) spans.push({ t: 'bold', spans: parseSpans(token.slice(2, -2)) });
    else if (token.startsWith('*')) spans.push({ t: 'italic', spans: parseSpans(token.slice(1, -1)) });
    else spans.push({ t: 'link', text: token.slice(1, token.indexOf(']')) });
    last = m.index + token.length;
  }
  if (last < text.length) spans.push({ t: 'text', text: text.slice(last) });
  return spans;
}

/** The subset of markdown model answers use: headings, lists, quotes, fenced code, rules, bold/italic/code. */
export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // the closing fence, or the end of the text
      blocks.push({ t: 'code', text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      blocks.push({ t: 'heading', level: heading[1].length, spans: parseSpans(heading[2]) });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: MdSpan[][] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(parseSpans(lines[i].replace(/^\s*>\s?/, '')));
        i++;
      }
      blocks.push({ t: 'quote', lines: quote });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const re = ordered ? /^\s*\d+[.)]\s+(.*)/ : /^\s*[-*+]\s+(.*)/;
      const items: MdSpan[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(parseSpans(m[1]));
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    blocks.push({ t: 'p', spans: parseSpans(line) });
    i++;
  }
  return blocks;
}
