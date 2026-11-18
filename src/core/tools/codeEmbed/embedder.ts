/**
 * papr-embed-code-1-0.6b on device: ONNX int8 through onnxruntime-node, tokenised with @huggingface/tokenizers.
 * Same recipe as the model card and the cloud index: right padding, EOS appended, last-token pool, L2 norm.
 * Queries get "Instruct: ...\nQuery:" ; documents never do. Empty strings are never embedded (int8 drifts on them).
 *
 * Both packages are optional dependencies: if either is missing, or the model files are not downloaded, load()
 * throws and callers fall back to the cloud tier or graph + exact words.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CODE_EMBED_MODEL = "papr-embed-code-1-0.6b";
export const CODE_EMBED_DIM = 1024;
export const HF_REPO = "papr-ai/papr-embed-code-1-0.6b";
export const MODEL_FILES = ["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json"] as const;
/** Apple Silicon only: the Neural Engine build (multifunction .mlpackage = a directory of these files). */
export const COREML_FILES = [
  "coreml/papr-embed-code-1-0.6b.mlpackage/Manifest.json",
  "coreml/papr-embed-code-1-0.6b.mlpackage/Data/com.apple.CoreML/model.mlmodel",
  "coreml/papr-embed-code-1-0.6b.mlpackage/Data/com.apple.CoreML/weights/weight.bin",
] as const;
export const QUERY_INSTRUCTION =
  "Given a code search query about a repository, retrieve the source code file that must be read or edited";
/** Every chunk is at most CHUNK_TOKENS (1000) tokens, long lines included (chunker.ts), so nothing legitimate reaches
 *  this. It is the last guard: it used to be 8192, and one 8k-token run makes onnxruntime allocate several GB (measured
 *  2.3 GB at 4k tokens, in process, CPU arena on), which aborts natively under memory pressure (Nov 17 crash loop). */
export const MAX_DOC_TOKENS = 1024;
export const MAX_QUERY_TOKENS = 512;

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embedQuery(text: string): Promise<Float32Array>;
  /** One vector per text, same order. Throws on empty text. */
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  countTokens(text: string): number;
  close(): Promise<void>;
}

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (!n || !Number.isFinite(n)) throw new Error("embedding is zero or not finite");
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function modelDir(root: string): string {
  return path.join(root, "models", CODE_EMBED_MODEL);
}

/** All base files present at their pinned sizes (a cheap stat; hashes are checked once, at download). */
export function modelInstalled(root: string): boolean {
  return MODEL_FILES.every((f) => sizeIs(path.join(modelDir(root), f), MODEL_MANIFEST[f]!.size));
}

/** Pinned model revision. Every file is checked against this manifest (size + sha256, or git blob sha1 for the small
 *  non-LFS files) so a truncated, corrupted or swapped download is never loaded. Bump both together. */
export const HF_REVISION = "4596a3478f5bc1898d9fae1afad200201ca741e1";
export interface ModelFileSpec { size: number; sha256?: string; gitSha1?: string }
export const MODEL_MANIFEST: Record<string, ModelFileSpec> = {
  "onnx/model_quantized.onnx": { size: 1118244486, sha256: "ee1bc67100688d06a57887958dd8cf3118b91ace5bae7a1d38d220cca4cdfb07" },
  "tokenizer.json": { size: 11423705, sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a" },
  "tokenizer_config.json": { size: 9703, gitSha1: "32f1ffc7372877c54ccf3891b37b61189b537263" },
  "coreml/papr-embed-code-1-0.6b.mlpackage/Manifest.json": { size: 617, gitSha1: "4493337539ec6eefbe9db00abb73d81a65260598" },
  "coreml/papr-embed-code-1-0.6b.mlpackage/Data/com.apple.CoreML/model.mlmodel": { size: 1883832, sha256: "d7dffa6571e505e83a8afbe5c90c4a4ee5b10313888e77e75b35355e41a6b7d0" },
  "coreml/papr-embed-code-1-0.6b.mlpackage/Data/com.apple.CoreML/weights/weight.bin": { size: 1194510528, sha256: "293bae84852f91c032a79417a90dd92d0a058df559069f78d34a83d88cf2c1ee" },
};

/**
 * Download missing model files from Hugging Face (pinned revision) into <root>/models/<model>/.
 * Streams to <file>.part (constant memory, not a 1.1 GB buffer), resumes a partial .part with an HTTP Range request,
 * verifies size + hash, and only then renames into place. A file that fails verification is deleted and the call
 * throws, so the next attempt starts clean. Files already in place are trusted if their size matches.
 */
export async function downloadModel(
  root: string,
  fetchImpl: typeof fetch = fetch,
  opts: { coreml?: boolean; manifest?: Record<string, ModelFileSpec>; revision?: string; files?: readonly string[] } = {},
): Promise<void> {
  const dir = modelDir(root);
  const manifest = opts.manifest ?? MODEL_MANIFEST;
  const coreml = opts.coreml ?? (process.platform === "darwin" && process.arch === "arm64");
  for (const f of opts.files ?? [...MODEL_FILES, ...(coreml ? COREML_FILES : [])]) {
    const spec = manifest[f];
    if (!spec) throw new Error(`no manifest entry for ${f}`);
    const dest = path.join(dir, f);
    if (sizeIs(dest, spec.size)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    let have = fileSize(tmp);
    if (have > spec.size) { fs.rmSync(tmp, { force: true }); have = 0; }
    const url = `https://huggingface.co/${HF_REPO}/resolve/${opts.revision ?? HF_REVISION}/${f}`;
    const res = await fetchImpl(url, have > 0 && have < spec.size ? { headers: { Range: `bytes=${have}-` } } : undefined);
    if (res.status === 200) have = 0; // server ignored the range: start over
    else if (res.status !== 206 && !(have === spec.size && res.status === 416)) throw new Error(`download ${f}: HTTP ${res.status}`);
    if (res.status !== 416) {
      if (!res.body) throw new Error(`download ${f}: empty body`);
      const out = fs.createWriteStream(tmp, { flags: have > 0 ? "a" : "w" });
      try {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      } finally {
        await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      }
    }
    const err = await verifyFile(tmp, spec);
    if (err) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`download ${f}: ${err}`);
    }
    fs.renameSync(tmp, dest);
  }
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}
function sizeIs(p: string, size: number): boolean {
  try { const st = fs.statSync(p); return st.isFile() && st.size === size; } catch { return false; }
}

/** null when the file matches its spec, else the reason. Hashes by streaming (never loads the file whole). */
export async function verifyFile(p: string, spec: ModelFileSpec): Promise<string | null> {
  const size = fileSize(p);
  if (size !== spec.size) return `size ${size}, expected ${spec.size}`;
  const { createHash } = await import("crypto");
  const h = createHash(spec.sha256 ? "sha256" : "sha1");
  if (!spec.sha256) h.update(`blob ${size}\0`);
  for await (const c of fs.createReadStream(p)) h.update(c as Buffer);
  const got = h.digest("hex");
  const want = spec.sha256 ?? spec.gitSha1;
  return got === want ? null : `hash ${got.slice(0, 12)}…, expected ${want?.slice(0, 12)}…`;
}

class OnnxEmbedder implements Embedder {
  readonly model = CODE_EMBED_MODEL;
  readonly dim = CODE_EMBED_DIM;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ort: any,
    private readonly session: any,
    private readonly tok: any,
    private readonly eos: number,
  ) {}

  private ids(text: string, max: number): number[] {
    const ids: number[] = this.tok.encode(text, { add_special_tokens: false }).ids;
    return ids.slice(0, max - 1).concat(this.eos);
  }

  countTokens(text: string): number {
    return this.tok.encode(text, { add_special_tokens: false }).ids.length;
  }

  /** onnxruntime sessions are not re-entrant: serialise runs. */
  private run(seqs: number[][]): Promise<Float32Array[]> {
    const job = this.queue.then(async () => {
      const L = Math.max(...seqs.map((s) => s.length));
      const ids = new BigInt64Array(seqs.length * L);
      const mask = new BigInt64Array(seqs.length * L);
      seqs.forEach((s, r) => s.forEach((t, c) => { ids[r * L + c] = BigInt(t); mask[r * L + c] = 1n; }));
      const out = await this.session.run({
        input_ids: new this.ort.Tensor("int64", ids, [seqs.length, L]),
        attention_mask: new this.ort.Tensor("int64", mask, [seqs.length, L]),
      });
      const h = out.last_hidden_state;
      const D = h.dims[2];
      const data = h.data as Float32Array;
      return seqs.map((s, r) => l2normalize(data.slice((r * L + s.length - 1) * D, (r * L + s.length) * D)));
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (!text.trim()) throw new Error("empty query");
    return (await this.run([this.ids(`Instruct: ${QUERY_INSTRUCTION}\nQuery:${text}`, MAX_QUERY_TOKENS)]))[0]!;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.some((t) => !t.trim())) throw new Error("empty document");
    // One at a time: right padding wastes compute on mixed lengths, and CPU int8 gains little from batching.
    const out: Float32Array[] = [];
    for (const t of texts) out.push(...(await this.run([this.ids(t, MAX_DOC_TOKENS)])));
    return out;
  }

  async close(): Promise<void> {
    await this.session?.release?.();
  }
}

/** Tokenizer files only (~11 MB): enough for a cloud-tier device to cut the exact chunks a Mac would, no model. */
export const TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json"] as const;

export function tokenizerInstalled(root: string): boolean {
  return TOKENIZER_FILES.every((f) => sizeIs(path.join(modelDir(root), f), MODEL_MANIFEST[f]!.size));
}

/** Download just the tokenizer (pinned, verified, resumable: same path as the model download). */
export function downloadTokenizer(root: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const manifest = Object.fromEntries(TOKENIZER_FILES.map((f) => [f, MODEL_MANIFEST[f]!]));
  return downloadModel(root, fetchImpl, { coreml: false, manifest, files: TOKENIZER_FILES });
}

/** Token counter with the model's tokenizer (pure JS, no onnxruntime). */
export async function loadTokenCounter(root: string): Promise<(text: string) => number> {
  const dir = modelDir(root);
  const { Tokenizer }: any = await import("@huggingface/tokenizers");
  const tok = new Tokenizer(
    JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")),
  );
  return (text: string) => tok.encode(text, { add_special_tokens: false }).ids.length;
}

/** Load the on-device embedder. Throws if packages or model files are missing. */
export async function loadEmbedder(root: string, opts: { threads?: number } = {}): Promise<Embedder> {
  const dir = modelDir(root);
  if (!modelInstalled(root)) throw new Error(`model not installed in ${dir}`);
  const ort: any = await import("onnxruntime-node");
  const { Tokenizer }: any = await import("@huggingface/tokenizers");
  const tok = new Tokenizer(
    JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")),
  );
  const eos = tok.encode("<|endoftext|>", { add_special_tokens: false }).ids[0];
  if (typeof eos !== "number") throw new Error("tokenizer has no <|endoftext|>");
  const session = await (ort.InferenceSession ?? ort.default.InferenceSession).create(
    path.join(dir, "onnx/model_quantized.onnx"),
    {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      // No BFC arena: it grows to the largest run ever seen and never gives memory back, and an arena Extend that
      // fails under memory pressure aborts the process. Plain allocations free after each run.
      enableCpuMemArena: false,
      enableMemPattern: false,
      // Leave cores for the app: indexing is background work.
      intraOpNumThreads: opts.threads ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
    },
  );
  return new OnnxEmbedder(ort.Tensor ? ort : ort.default, session, tok, eos);
}

/**
 * Best embedder for this machine: CoreML on the Neural Engine (Apple Silicon, helper + coreml/ model present), with ONNX
 * as the fallback for long documents; otherwise ONNX alone. Never throws for CoreML problems, only if ONNX also fails.
 */
export async function loadBestEmbedder(root: string, opts: { threads?: number; helper?: string } = {}): Promise<Embedder> {
  const onnx = await loadEmbedder(root, opts);
  if (process.platform !== "darwin" || process.arch !== "arm64") return onnx;
  try {
    const { CoreMLEmbedder, COREML_MODEL, helperPath } = await import("./coremlEmbedder.js");
    const { Tokenizer }: any = await import("@huggingface/tokenizers");
    const dir = modelDir(root);
    const tok = new Tokenizer(
      JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8")),
      JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")),
    );
    return await CoreMLEmbedder.start({ helper: opts.helper ?? helperPath(), modelPath: path.join(dir, COREML_MODEL), tok, fallback: onnx });
  } catch {
    return onnx;
  }
}

/**
 * ONNX embedder in a child process (see embedWorker.ts). onnxruntime aborts natively when an allocation fails
 * (EXC_BREAKPOINT in BFCArena::Extend), and in a worker thread that took the whole gateway down with it. In a child
 * process the abort only kills the child: pending calls reject, onExit fires, and the runtime falls back.
 * Token counts use a tokenizer in this process (cheap, sync). Same vectors as loadEmbedder.
 */
export class WorkerOnnxEmbedder implements Embedder {
  readonly model = CODE_EMBED_MODEL;
  readonly dim = CODE_EMBED_DIM;
  private next = 1;
  private pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  private closing = false;
  private exitListeners: Array<(info: { code: number | null; signal: string | null }) => void> = [];
  dead = false;

  private constructor(private readonly child: import("node:child_process").ChildProcess, private readonly tok: any) {
    child.on("message", (m: any) => {
      const p = m?.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.ok(m) : p.err(new Error(m.error ?? "embed worker error"));
    });
    child.on("exit", (code, signal) => {
      this.dead = true;
      const e = new Error(`embed process exited (${signal ?? code})`);
      for (const p of this.pending.values()) p.err(e);
      this.pending.clear();
      if (!this.closing) for (const l of this.exitListeners) l({ code, signal });
    });
    child.on("error", () => undefined); // exit follows
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Called once if the process dies on its own (native abort, OOM kill), not after close(). */
  onExit(l: (info: { code: number | null; signal: string | null }) => void): void {
    this.exitListeners.push(l);
  }

  /** opts.entry + opts.tok: run another child script with a given tokenizer (tests). */
  static async start(root: string, opts: { threads?: number; entry?: string; tok?: any; env?: Record<string, string> } = {}): Promise<WorkerOnnxEmbedder> {
    const { fork } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    let tok = opts.tok;
    if (!tok) {
      if (!modelInstalled(root)) throw new Error(`model not installed in ${modelDir(root)}`);
      const { Tokenizer }: any = await import("@huggingface/tokenizers");
      const dir = modelDir(root);
      tok = new Tokenizer(
        JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8")),
        JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")),
      );
    }
    const here = new URL(import.meta.url);
    // Built JS ships embedWorker.js; under tsx (dev/tests) the .ts source runs with the tsx loader.
    const ts = here.pathname.endsWith(".ts");
    const entry = opts.entry ?? fileURLToPath(new URL(ts ? "./embedWorker.ts" : "./embedWorker.js", here));
    const execArgv = entry.endsWith(".ts") ? ["--import", (await import("node:module")).createRequire(import.meta.url).resolve("tsx/esm")] : [];
    const child = fork(entry, [], {
      // process.execPath is Electron in the app: ELECTRON_RUN_AS_NODE makes it plain Node with the same native ABI
      // the gateway already loads onnxruntime-node with.
      execPath: process.execPath,
      execArgv,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PAPR_EMBED_ROOT: root, PAPR_EMBED_THREADS: opts.threads ? String(opts.threads) : "", ...opts.env },
      serialization: "advanced", // Float32Array crosses as-is
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    child.unref();
    (child as any).channel?.unref?.();
    await new Promise<void>((ok, err) => {
      const t = setTimeout(() => { child.kill(); err(new Error("embed process load timeout")); }, 120_000);
      const onExit = (c: number | null, s: string | null) => { clearTimeout(t); err(new Error(`embed process exited during load (${s ?? c})`)); };
      child.once("exit", onExit);
      child.once("message", (m: any) => {
        clearTimeout(t);
        child.off("exit", onExit);
        m?.ready ? ok() : (child.kill(), err(new Error(m?.error ?? "embed process failed")));
      });
    });
    return new WorkerOnnxEmbedder(child, tok);
  }

  private call(op: string, body: Record<string, unknown>): Promise<any> {
    if (this.dead) return Promise.reject(new Error("embed process is not running"));
    const id = this.next++;
    return new Promise((ok, err) => {
      this.pending.set(id, { ok, err });
      (this.child as any).channel?.ref?.(); // keep the channel alive while a call is out
      this.child.send({ id, op, ...body }, (e) => { if (e) { this.pending.delete(id); err(e); } });
    }).finally(() => { if (!this.pending.size) (this.child as any).channel?.unref?.(); });
  }

  countTokens(text: string): number {
    return this.tok.encode(text, { add_special_tokens: false }).ids.length;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (!text.trim()) throw new Error("empty query");
    return (await this.call("query", { text })).vecs[0];
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.some((t) => !t.trim())) throw new Error("empty document");
    return (await this.call("docs", { texts })).vecs;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.dead) return;
    await Promise.race([this.call("close", {}).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
    if (!this.dead) this.child.kill();
  }
}
