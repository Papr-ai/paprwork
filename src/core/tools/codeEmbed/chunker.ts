/**
 * Split a file into embedding chunks that each fit the Neural Engine's longest function (1024 tokens), so nothing
 * on the device path falls back to slow CPU inference. A file that fits is one chunk. A longer file becomes
 * line-aligned windows (~1000 tokens, ~100 overlap), each prefixed "File: <path>". Token counts come from the real
 * tokenizer when given, else a 4-chars-per-token estimate.
 */
export const LONG_CHARS = 3_500;
export const CHUNK_TOKENS = 1000;
export const OVERLAP_TOKENS = 100;

/** Generated or minified files can be megabytes on a few lines: index their start, not thousands of chunks. */
export const MAX_CHUNKS_PER_FILE = 64;

/** Cut one long line into pieces of at most `budget` tokens, by characters (binary search on the real count). */
export function splitLongLine(line: string, budget: number, countTokens: (s: string) => number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length && out.length < MAX_CHUNKS_PER_FILE) {
    if (countTokens(rest) <= budget) { out.push(rest); break; }
    let lo = 1, hi = Math.min(rest.length, budget * 8);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (countTokens(rest.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
    }
    out.push(rest.slice(0, lo));
    rest = rest.slice(lo);
  }
  return out;
}

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
    if (end === start + 1 && tokens > budget) {
      // One line longer than a whole chunk (minified JS, one-line JSON, a data URI). It used to become a single chunk of
      // any size: 368k characters in the bench corpus, cut only at MAX_DOC_TOKENS, which made onnxruntime allocate
      // gigabytes for one run (the Nov 17 gateway crash). Split it into budget-sized pieces of the same line instead.
      for (const piece of splitLongLine(lines[start]!, budget, countTokens)) {
        if (out.length >= MAX_CHUNKS_PER_FILE) return out;
        if (piece.trim()) out.push({ chunk: out.length, text: header + piece, lineStart: start + 1, lineEnd: start + 1 });
      }
      start = end;
      continue;
    }
    const body = lines.slice(start, end).join("\n");
    if (out.length >= MAX_CHUNKS_PER_FILE) return out;
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
