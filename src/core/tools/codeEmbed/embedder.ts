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
export const QUERY_INSTRUCTION =
  "Given a code search query about a repository, retrieve the source code file that must be read or edited";
export const MAX_DOC_TOKENS = 8192;
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

export function modelInstalled(root: string): boolean {
  return MODEL_FILES.every((f) => fs.existsSync(path.join(modelDir(root), f)));
}

/** Download missing model files from Hugging Face into <root>/models/<model>/ (resumable per file, atomic rename). */
export async function downloadModel(root: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const dir = modelDir(root);
  for (const f of MODEL_FILES) {
    const dest = path.join(dir, f);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetchImpl(`https://huggingface.co/${HF_REPO}/resolve/main/${f}`);
    if (!res.ok || !res.body) throw new Error(`download ${f}: HTTP ${res.status}`);
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
  }
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
      // Leave cores for the app: indexing is background work.
      intraOpNumThreads: opts.threads ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
    },
  );
  return new OnnxEmbedder(ort.Tensor ? ort : ort.default, session, tok, eos);
}
