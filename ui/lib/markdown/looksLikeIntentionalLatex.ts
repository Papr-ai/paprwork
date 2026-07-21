/**
 * Heuristic gate for remark-math nodes.
 * Keeps real LaTeX on the KaTeX path; downgrades prose/ratios wrapped in $...$.
 */
export function looksLikeIntentionalLatex(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  // LaTeX commands (\frac, \pi, etc.)
  if (/\\[a-zA-Z]+/.test(trimmed)) return true;

  // Sub/superscripts and grouping
  if (/[\^_{}]/.test(trimmed)) return true;

  // Pure numbers, ratios, or numeric expressions without LaTeX syntax
  if (/^[\d\s.,+\-*/=()]+$/.test(trimmed)) return false;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return false;

  // Long alphabetic runs (e.g. tradeshowvs) are prose labels, not math
  if (/[a-zA-Z]{4,}/.test(trimmed)) return false;

  // Multiple space-separated words (English prose inside $...$)
  if (/\b[a-zA-Z]{2,}\s+[a-zA-Z]{2,}\b/.test(trimmed)) return false;

  // Single-letter variables ($n$, $x$, $L$)
  if (/^[a-zA-Z]$/.test(trimmed)) return true;

  // Short symbolic expressions with operators ($E = mc^2$ handled above via ^)
  if (/^[a-zA-Z0-9=+\-*/().,\s]+$/.test(trimmed) && /[=+\-*/]/.test(trimmed)) {
    return true;
  }

  return false;
}
