/**
 * HTML tag-balance check for validate_app.
 *
 * Replaces a line-by-line regex that produced false "Potentially unclosed" warnings for:
 *   - self-closing tags (<path ... />, <circle />) — pushed as open, then every ancestor
 *     (<svg>, <button>, <div>, <main>, <body>, <html>) cascaded into the report
 *   - void elements missing from its list (source, area, base, col, embed, track, wbr…)
 *   - tags inside <script>/<style>/comments, and tags split across lines
 * This version tokenizes the whole document, respects quoted attributes, skips void /
 * self-closing / optional-end-tag elements, and recovers from a stray close tag without
 * cascading.
 */

export interface HtmlBalanceIssue {
  line: number;
  message: string;
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** End tag is optional per the HTML spec — never report these. */
const OPTIONAL_END_TAG = new Set([
  "html", "head", "body", "li", "p", "dt", "dd", "option", "optgroup",
  "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "rp", "rt", "caption",
]);

/** Replace a region with spaces/newlines so indexes and line numbers stay stable. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function stripNonMarkup(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, blank)
    .replace(/<!doctype[^>]*>/gi, blank)
    .replace(
      /(<(script|style|textarea|template)\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(<\/\2\s*>)/gi,
      (_m, open: string, _tag: string, body: string, close: string) => open + blank(body) + close,
    );
}

const TAG_RE = /<(\/)?([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

export function checkHtmlTagBalance(content: string): HtmlBalanceIssue[] {
  const src = stripNonMarkup(content);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const stack: Array<{ tag: string; line: number }> = [];
  const issues: HtmlBalanceIssue[] = [];

  for (const m of src.matchAll(TAG_RE)) {
    const isClose = Boolean(m[1]);
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    const line = lineOf(m.index ?? 0);

    if (!isClose) {
      if (VOID_ELEMENTS.has(tag) || /\/\s*$/.test(attrs)) continue;
      stack.push({ tag, line });
      continue;
    }

    let idx = stack.length - 1;
    while (idx >= 0 && stack[idx].tag !== tag) idx--;
    if (idx < 0) {
      if (!OPTIONAL_END_TAG.has(tag)) {
        issues.push({ line, message: `Unexpected closing </${tag}> tag with no matching opener` });
      }
      continue;
    }
    // Everything opened after the matching opener was never closed.
    for (const open of stack.splice(idx)) {
      if (open.tag !== tag && !OPTIONAL_END_TAG.has(open.tag)) {
        issues.push({ line: open.line, message: `Potentially unclosed <${open.tag}> tag` });
      }
    }
  }

  for (const open of stack) {
    if (!OPTIONAL_END_TAG.has(open.tag)) {
      issues.push({ line: open.line, message: `Potentially unclosed <${open.tag}> tag` });
    }
  }
  return issues.sort((a, b) => a.line - b.line);
}
