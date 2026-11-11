/**
 * Split a file into embedding chunks: chunk 0 is the file head; files over LONG_CHARS also get line-aligned windows
 * (~8k tokens, 1k overlap), each prefixed "File: <path>" like the replay index. Token counts come from the real
 * tokenizer when given, else a 4-chars-per-token estimate.
 */
export const LONG_CHARS = 24_000;
export const CHUNK_TOKENS = 8192;
export const OVERLAP_TOKENS = 1024;

export interface Chunk {
  chunk: number;
  text: string;
  lineStart: number;
  lineEnd: number;
}

export function chunkFile(path: string, text: string, countTokens: (s: string) => number = (s) => Math.ceil(s.length / 4)): Chunk[] {
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const head: Chunk = { chunk: 0, text, lineStart: 1, lineEnd: lines.length };
  if (text.length <= LONG_CHARS) return [head];
  const header = `File: ${path}\n`;
  const budget = CHUNK_TOKENS - countTokens(header) - 1;
  const out: Chunk[] = [head];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let tokens = 0;
    while (end < lines.length) {
      const t = countTokens(lines[end]! + "\n");
      if (tokens + t > budget && end > start) break;
      tokens += t;
      end++;
    }
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) out.push({ chunk: out.length, text: header + body, lineStart: start + 1, lineEnd: end });
    if (end >= lines.length) break;
    // step back ~OVERLAP_TOKENS worth of lines
    let back = end;
    let ov = 0;
    while (back > start + 1 && ov < OVERLAP_TOKENS) ov += countTokens(lines[--back]! + "\n");
    start = Math.max(start + 1, back);
  }
  return out;
}
