import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Model output is untrusted: no remote resources, scripts or active links. */
export function renderAnswerMarkdown(answer: string): string {
  return DOMPurify.sanitize(marked.parse(answer, { async: false, gfm: true, breaks: true }), {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a'],
    ALLOWED_ATTR: [],
  });
}
