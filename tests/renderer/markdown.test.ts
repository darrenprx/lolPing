import { describe, expect, it } from 'vitest';
import { parseMarkdown, parseSpans } from '../../src/renderer/answer/markdown';

describe('parseSpans', () => {
  it('keeps plain text as one span', () => {
    expect(parseSpans('just text')).toEqual([{ t: 'text', text: 'just text' }]);
  });

  it('reads bold, italic and inline code', () => {
    expect(parseSpans('a **b** *c* `d` e')).toEqual([
      { t: 'text', text: 'a ' },
      { t: 'bold', spans: [{ t: 'text', text: 'b' }] },
      { t: 'text', text: ' ' },
      { t: 'italic', spans: [{ t: 'text', text: 'c' }] },
      { t: 'text', text: ' ' },
      { t: 'code', text: 'd' },
      { t: 'text', text: ' e' },
    ]);
  });

  it('keeps a link label and drops its target', () => {
    expect(parseSpans('see [the docs](https://example.com/x) now')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'link', text: 'the docs' },
      { t: 'text', text: ' now' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('splits a document into paragraphs and skips blank lines', () => {
    expect(parseMarkdown('one\n\ntwo')).toEqual([
      { t: 'p', spans: [{ t: 'text', text: 'one' }] },
      { t: 'p', spans: [{ t: 'text', text: 'two' }] },
    ]);
  });

  it('reads headings of their levels', () => {
    expect(parseMarkdown('# big\n### small')).toEqual([
      { t: 'heading', level: 1, spans: [{ t: 'text', text: 'big' }] },
      { t: 'heading', level: 3, spans: [{ t: 'text', text: 'small' }] },
    ]);
  });

  it('collects fenced code verbatim, without inline marks', () => {
    expect(parseMarkdown('```js\nlet a = **1**;\n```')).toEqual([
      { t: 'code', text: 'let a = **1**;' },
    ]);
  });

  it('reads bullet and numbered lists of consecutive items', () => {
    expect(parseMarkdown('- one\n- two\n1. first\n2. second')).toEqual([
      { t: 'list', ordered: false, items: [[{ t: 'text', text: 'one' }], [{ t: 'text', text: 'two' }]] },
      { t: 'list', ordered: true, items: [[{ t: 'text', text: 'first' }], [{ t: 'text', text: 'second' }]] },
    ]);
  });

  it('groups quote lines and reads rules', () => {
    expect(parseMarkdown('> a\n> b\n\n---')).toEqual([
      { t: 'quote', lines: [[{ t: 'text', text: 'a' }], [{ t: 'text', text: 'b' }]] },
      { t: 'hr' },
    ]);
  });

  it('turns a whole model answer into ordered blocks', () => {
    const blocks = parseMarkdown('### 局势\n- **装备**：三个大件\n```json\n{"a":1}\n```\n总之 *稳住*。');
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'list', 'code', 'p']);
  });

  it('survives empty and fence-only input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('```\n```')).toEqual([{ t: 'code', text: '' }]);
  });
});
