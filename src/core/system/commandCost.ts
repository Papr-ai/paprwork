/**
 * How much memory a shell command is likely to need, before it runs.
 *
 * Heavy = loads a model or a VM-sized runtime (torch / transformers scripts, local LLM servers, docker). The Nov 19
 * panic had four such Python processes from agents (3.5-5.6 GB each) on a 16 GB Mac. Light commands (grep, git, ls,
 * cat, curl, sqlite3, most npm/node scripts) never wait.
 *
 * The regex is the first guess. Every agent-started process tree is measured by the watchdog, and a command shape that
 * once peaked over HEAVY_LEARNED_BYTES is treated as heavy from then on (learned table, persisted).
 */
import * as fs from "fs";
import * as path from "path";

export type CostClass = "light" | "medium" | "heavy";
export interface CommandCost { cls: CostClass; estimateBytes: number; signature: string; why: string }

const GB = 1024 ** 3;
export const HEAVY_DEFAULT_BYTES = 4 * GB;
export const MEDIUM_DEFAULT_BYTES = 1 * GB;
/** A shape that peaked above this once is heavy from then on. */
export const HEAVY_LEARNED_BYTES = 1.5 * GB;

const HEAVY: Array<[RegExp, string]> = [
  [/\b(ollama\s+(run|serve)|llama-(server|cli)|llama\.cpp|mlx_lm|vllm|text-generation-launcher|lmstudio|lms\s+load)\b/, "local LLM"],
  [/\bdocker\s+(run|compose\s+up|build)|\bdocker-compose\s+up\b|\bpodman\s+run\b/, "container"],
  [/\b(python[\d.]*|uv\s+run|poetry\s+run|pipenv\s+run)\b[^|;&]*\s--(model|device|workers|checkpoint|weights)\b/, "Python with a model / device flag"],
  [/\b(python[\d.]*|uv\s+run|poetry\s+run)\b[^|;&]*\b[\w./-]*(train|finetune|embed|encode|inference|infer|serve|worker|e2e_local|bench|eval|convert|quantiz)\w*\.py\b/, "Python model script"],
  [/\b(python[\d.]*)\s+-c\s+["'][^"']*\b(torch|transformers|sentence_transformers|mlx|onnxruntime|coremltools|vllm|tensorflow|jax)\b/, "inline Python loading ML libraries"],
  [/\b(torchrun|accelerate\s+launch|deepspeed)\b/, "distributed torch launcher"],
];
const MEDIUM: Array<[RegExp, string]> = [
  [/\b(pytest|vitest|jest|cargo\s+(build|test)|go\s+(build|test)|xcodebuild|gradle|mvn|swift\s+build|tsc\b|webpack|next\s+build|vite\s+build|npm\s+(ci|install|run\s+build|test))\b/, "build / test suite"],
  [/\b(python[\d.]*|node|npx\s+tsx|tsx)\s+[\w./-]+\.(py|mts|ts|js|mjs)\b/, "script"],
];

/** Stable shape of a command for the learned table: launcher + script basename (+ --model value). */
export function commandSignature(command: string): string {
  const c = command.replace(/\s+/g, " ").trim();
  const script = c.match(/([\w.-]+\.(py|mts|ts|js|mjs|sh))\b/)?.[1];
  const launcher = c.match(/\b(python[\d.]*|uv run|poetry run|node|npx tsx|tsx|ollama|docker|llama-server|torchrun|pytest|vitest)\b/)?.[1];
  const model = c.match(/--model[ =]([\w./:-]+)/)?.[1];
  return [launcher ?? c.split(" ")[0], script, model].filter(Boolean).join(" ");
}

export function estimateCommandCost(command: string, learned: Record<string, number> = {}): CommandCost {
  const signature = commandSignature(command);
  const peak = learned[signature];
  if (peak !== undefined && peak >= HEAVY_LEARNED_BYTES)
    return { cls: "heavy", estimateBytes: Math.round(peak * 1.1), signature, why: `peaked at ${(peak / GB).toFixed(1)} GB last time` };
  // Measured small before (e.g. an "eval_report.py" the name regex flags): trust the measurement, not the name.
  if (peak !== undefined && peak < HEAVY_LEARNED_BYTES / 2)
    return { cls: "medium", estimateBytes: Math.round(peak * 1.2), signature, why: `peaked at ${(peak / GB).toFixed(2)} GB last time` };
  for (const [re, why] of HEAVY) if (re.test(command)) return { cls: "heavy", estimateBytes: Math.max(HEAVY_DEFAULT_BYTES, peak ?? 0), signature, why };
  for (const [re, why] of MEDIUM) if (re.test(command)) return { cls: "medium", estimateBytes: Math.max(MEDIUM_DEFAULT_BYTES, peak ?? 0), signature, why };
  return { cls: "light", estimateBytes: 0, signature, why: "light command" };
}

/** Learned peak RSS per command signature, persisted under the data dir (best effort). */
export class LearnedPeaks {
  private table: Record<string, number> = {};
  constructor(private readonly file: string | null) {
    if (file) try { this.table = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.table = {}; }
  }
  get all(): Record<string, number> { return this.table; }
  record(signature: string, peakBytes: number): void {
    if (!signature || peakBytes < 256 * 1024 ** 2) return;
    // Remember the larger of the old and new peaks, decayed a little so a one-off spike fades over many runs.
    const prev = this.table[signature] ?? 0;
    this.table[signature] = Math.round(Math.max(peakBytes, prev * 0.9));
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.table));
    } catch { /* best effort */ }
  }
}
