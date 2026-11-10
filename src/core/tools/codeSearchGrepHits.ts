/**
 * Files named in grep / rg / find output, in order of first appearance (absolute or relative).
 * Used by papr-code-search v2 so pointers never repeat a file grep already printed.
 */
const HIT =
  /^((?:\/|\.\/|~\/)?(?:[\w.\-@~ ]+\/)*[\w.\-@]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|css|html|json|sql|md|sh))(?=[:-]\d+[:-]|:|$)/;

export function grepHitFiles(output: string, limit = 400): string[] {
  const seen = new Set<string>();
  for (const line of output.split("\n").slice(0, limit)) {
    const m = HIT.exec(line.trim());
    if (m) seen.add(m[1].replace(/^\.\//, ""));
  }
  return [...seen];
}
