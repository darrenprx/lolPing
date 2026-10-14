// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderAnswerMarkdown } from '../../src/renderer/answer/markdown';

describe('AI answer Markdown', () => {
  it('renders headings, lists, fenced code and tables', () => {
    const html = renderAnswerMarkdown('# 解释\n\n- **重点**\n\n```js\nconst a = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<h1>解释</h1>');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('<table>');
  });
  it('removes scripts, event handlers, remote images and active links', () => {
    const html = renderAnswerMarkdown('<script>alert(1)</script><img src="https://tracker.example" onerror="alert(1)"><a href="javascript:alert(1)">链接</a>');
    expect(html).not.toMatch(/script|img|onerror|href=/i);
    expect(html).toContain('链接');
  });
});
