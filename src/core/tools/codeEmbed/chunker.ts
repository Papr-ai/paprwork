/**
 * Split a file into embedding chunks that each fit the Neural Engine's longest function (1024 tokens), so nothing
 * on the device path falls back to slow CPU inference. A file that fits is one chunk. A longer file becomes
 * line-aligned windows (~1000 tokens, ~100 overlap), each prefixed "File: <path>". Token counts come from the real
 * tokenizer when given, else a 4-chars-per-token estimate.
 */
export const LONG_CHARS = 3_500;
export const CHUNK_TOKENS = 1000;
export const OVERLAP_TOKENS = 100;

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
  // Fits the Neural Engine in one go: a single chunk. Always decided by the token count: code runs 2-3 chars/token,
  // so a character estimate would let 1,400-token files through.
  if (countTokens(text) + 1 <= CHUNK_TOKENS) return [head];
  const header = `File: ${path}\n`;
  const budget = CHUNK_TOKENS - countTokens(header) - 1;
  const out: Chunk[] = [];
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
