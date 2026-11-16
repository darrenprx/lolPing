import { sanitizeText, sanitizeTopic } from './roomProtocol';

/** What the text box produced: a message to show, one of the vote commands, or nothing usable. */
export type TextInput =
  | { kind: 'text'; text: string }
  | { kind: 'ff'; topic?: string }
  | { kind: 'noff' }
  | { kind: 'ready'; topic?: string }
  | { kind: 'unknown' }
  | { kind: 'empty' };

/**
 * Commands start with a slash and match as a whole word; /surrender is the long form of /ff. Words after /ff or
 * /ready are what the vote is about (#118); /noff takes none.
 */
export function parseTextInput(raw: string): TextInput {
  const text = sanitizeText(raw);
  if (text === '') return { kind: 'empty' };
  if (!text.startsWith('/')) return { kind: 'text', text };
  const space = text.search(/\s/);
  const word = (space < 0 ? text : text.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : text.slice(space);
  const topic = sanitizeTopic(rest);
  const about = topic ? { topic } : {};
  switch (word) {
    case '/ff':
    case '/surrender':
      return { kind: 'ff', ...about };
    case '/noff':
      return rest.trim() === '' ? { kind: 'noff' } : { kind: 'unknown' };
    case '/ready':
      return { kind: 'ready', ...about };
    default:
      return { kind: 'unknown' };
  }
}
