/**
 * Apple Neural Engine backend: drives the papr-embed-coreml Swift helper (native/papr-embed-coreml) over stdin/stdout.
 * Same Embedder interface and same token recipe as the ONNX backend; the helper returns the final unit vector
 * (last-token pool + L2 norm happen inside the CoreML model). Texts longer than the largest compiled length
 * (1024 tokens in the release model) go to the fallback embedder, so file indexing still works.
 *
 * Only used on Apple Silicon macOS when the helper binary and coreml/ model are present; otherwise loadBest() returns ONNX.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { CODE_EMBED_DIM, CODE_EMBED_MODEL, MAX_QUERY_TOKENS, QUERY_INSTRUCTION, l2normalize, type Embedder } from "./embedder.js";

export const EOS_ENDOFTEXT = 151643;
export const COREML_MODEL = "coreml/papr-embed-code-1-0.6b.mlpackage";

interface Tok {
  encode(t: string, o: { add_special_tokens: boolean }): { ids: number[] };
}

export class CoreMLEmbedder implements Embedder {
  readonly model = CODE_EMBED_MODEL;
  readonly dim = CODE_EMBED_DIM;
  private next = 1;
  private pending = new Map<number, { ok: (v: Float32Array) => void; err: (e: Error) => void }>();

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly tok: Tok,
    readonly maxTokens: number,
    private readonly fallback: Embedder | null,
  ) {
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error || !Array.isArray(m.embedding)) p.err(new Error(m.error ?? "no embedding"));
      else p.ok(l2normalize(Float32Array.from(m.embedding)));
    });
    proc.on("exit", () => {
      for (const p of this.pending.values()) p.err(new Error("coreml helper exited"));
      this.pending.clear();
    });
  }

  /** Spawn the helper and wait for {"ready":true}. Throws if it fails to load within timeoutMs (first ANE compile ~50 s). */
  static async start(opts: { helper: string; modelPath: string; tok: Tok; fallback: Embedder | null; timeoutMs?: number }): Promise<CoreMLEmbedder> {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("CoreML backend needs Apple Silicon macOS");
    for (const f of [opts.helper, opts.modelPath]) if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
    const proc = spawn(opts.helper, [opts.modelPath], { stdio: ["pipe", "pipe", "pipe"] });
    const ready = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => { proc.kill(); reject(new Error("coreml helper load timeout")); }, opts.timeoutMs ?? 180_000);
      const rl = readline.createInterface({ input: proc.stdout });
      rl.once("line", (l) => { clearTimeout(t); rl.close(); try { resolve(JSON.parse(l)); } catch (e) { reject(e); } });
      proc.once("error", (e) => { clearTimeout(t); reject(e); });
    });
    if (!ready?.ready) { proc.kill(); throw new Error(`coreml helper failed: ${ready?.error ?? "unknown"}`); }
    const lens: number[] = (ready.functions as string[]).map((f) => Number(f.replace("len_", ""))).filter(Number.isFinite);
    return new CoreMLEmbedder(proc, opts.tok, Math.max(...lens), opts.fallback);
  }

  private ids(text: string, max: number): number[] {
    return this.tok.encode(text, { add_special_tokens: false }).ids.slice(0, max - 1).concat(EOS_ENDOFTEXT);
  }

  countTokens(text: string): number {
    return this.tok.encode(text, { add_special_tokens: false }).ids.length;
  }

  private run(ids: number[]): Promise<Float32Array> {
    const id = this.next++;
    return new Promise((ok, err) => {
      this.pending.set(id, { ok, err });
      this.proc.stdin.write(JSON.stringify({ id, ids }) + "\n");
    });
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (!text.trim()) throw new Error("empty query");
    const ids = this.ids(`Instruct: ${QUERY_INSTRUCTION}\nQuery:${text}`, Math.min(MAX_QUERY_TOKENS, this.maxTokens));
    return this.run(ids);
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.some((t) => !t.trim())) throw new Error("empty document");
    const out: Float32Array[] = [];
    for (const t of texts) {
      const n = this.countTokens(t) + 1;
      if (n > this.maxTokens) {
        if (!this.fallback) throw new Error(`document has ${n} tokens; CoreML max is ${this.maxTokens} and no fallback`);
        out.push(...(await this.fallback.embedDocuments([t])));
      } else {
        out.push(await this.run(this.ids(t, this.maxTokens)));
      }
    }
    return out;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    this.proc.kill();
    await this.fallback?.close();
  }
}

/** Where the helper binary lives: packaged app resources, else the dev build output. */
export function helperPath(resourcesDir = (process as any).resourcesPath ?? ""): string {
  const cands = [process.env.PAPR_CODE_EMBED_HELPER ?? "", path.join(resourcesDir, "bin", "papr-embed-coreml"), path.join(process.cwd(), "native", "papr-embed-coreml", "build", "papr-embed-coreml")];
  return cands.find((c) => c && fs.existsSync(c)) ?? cands[1]!;
}
