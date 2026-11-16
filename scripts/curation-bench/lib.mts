// Shared helpers for the Curation Bench scripts.
import * as fs from "fs";
import * as readline from "readline";
import * as zlib from "zlib";

export async function* gunzipLines(p: string): AsyncGenerator<string> {
  yield* readline.createInterface({ input: fs.createReadStream(p).pipe(zlib.createGunzip()), crlfDelay: Infinity });
}

/** Read a 2-D float16 .npy (numpy C order) into float32. */
export function loadNpyF16(p: string): { data: Float32Array; rows: number; dim: number } {
  const buf = fs.readFileSync(p);
  const hlen = buf.readUInt16LE(8);
  const header = buf.subarray(10, 10 + hlen).toString("latin1");
  if (!/'descr': '<f2'/.test(header) || /'fortran_order': True/.test(header)) throw new Error(`${p}: expected C-order <f2, got ${header}`);
  const [rows, dim] = header.match(/'shape': \((\d+), (\d+)\)/)!.slice(1).map(Number) as [number, number];
  const raw = new Uint16Array(buf.buffer.slice(buf.byteOffset + 10 + hlen, buf.byteOffset + 10 + hlen + rows * dim * 2));
  const data = new Float32Array(rows * dim);
  for (let i = 0; i < raw.length; i++) data[i] = f16(raw[i]!);
  return { data, rows, dim };
}

function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Same filter as codeSearchV2.readCorpus: text extensions, no dot/vendored dirs, no lock/min files, <= 400 KB. */
const TEXT_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".md", ".html", ".css", ".json", ".sql", ".sh"];
const SKIP_DIRS = new Set(["node_modules", "dist", "venv", ".venv", "__pycache__", "build", ".versions", ".git", "data"]);
export function readCorpusFilter(p: string, text: string): boolean {
  const segs = p.split("/");
  const name = segs[segs.length - 1]!;
  if (segs.some((s) => s.startsWith(".") || SKIP_DIRS.has(s))) return false;
  if (!TEXT_EXT.some((x) => name.endsWith(x)) || /lock|\.min\./.test(name)) return false;
  return Buffer.byteLength(text) <= 400_000;
}

/** The grep pattern bash.ts would see (detectPaprGrepCommand's regex, without the Papr-path check). */
export function detectGrep(cmd: string): string | null {
  const m = cmd.match(/\bgrep\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^"'\s]+))\s+(.+)/i);
  return m ? (m[1] ?? m[2] ?? m[3]!) : null;
}
