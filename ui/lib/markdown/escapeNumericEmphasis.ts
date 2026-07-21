/**
 * Escape emphasis markers sandwiched between digits/punctuation.
 * Prevents `0.275*tradeshowvs*.0.069` from italicizing the middle segment.
 */
export function escapeNumericEmphasis(markdown: string): string {
  return markdown.replace(
    /([\d.])(\*[^*\n]+\*)(?=[\d.])/g,
    (_match, prefix: string, emphasis: string) => {
      const escaped = emphasis.replace(/\*/g, "\\*");
      return `${prefix}${escaped}`;
    },
  );
}
