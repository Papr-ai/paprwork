/**
 * grep / rg inside one of the user's own git repos: on-device hits once they allowed the repo, a one-line ask while
 * undecided, nothing when denied. Uses the runtime only if it is already running (a grep never starts the index).
 */
import * as os from "os";
import * as path from "path";
import type { EmbedTier } from "./deviceHealth.js";
import { repoRootFor, reposEnabled } from "./repos.js";
import { runningCodeEmbedRuntime, type DeviceHit } from "./runtime.js";

/** First path-like token of a grep target ("src/ --include=*.ts" -> "src/"). */
function firstPathToken(p: string): string {
  return (
    p
      .trim()
      .match(/^"([^"]+)"|^'([^']+)'|^(\S+)/)
      ?.slice(1)
      .find(Boolean) ?? ""
  ).replace(/^~(?=\/|$)/, os.homedir());
}

export interface RepoGrepResult {
  tier: EmbedTier | "disabled";
  backend: string;
  hits: DeviceHit[];
  /** Set when the grep ran in a git repo the user has not decided about: ask once, then call code_index_repo. */
  askRepo?: string;
}

/** A grep inside one of the user's git repos: hits when allowed, an ask when undecided, nothing when denied. */
export async function repoHitsForGrep(
  grepPath: string,
  query: string,
  budgetMs = 2_000,
  cwd?: string,
): Promise<RepoGrepResult> {
  const none = { tier: "disabled" as const, backend: "none", hits: [] };
  try {
    if (!reposEnabled()) return none;
    let target = firstPathToken(grepPath);
    if (!target || !path.isAbsolute(target))
      target = cwd ? path.resolve(cwd, target || ".") : "";
    if (!target) return none;
    // Cheap check first (no runtime start): most greps are not in a git repo outside the Papr folder.
    if (!repoRootFor(target)) return none;
    // Only an already-running runtime (started with the app): a grep must never open an index as a side effect.
    const rt = await runningCodeEmbedRuntime();
    if (!rt) return none;
    const repo = rt.repoFor(target);
    if (!repo) return none;
    if (repo.decision === undefined) return { ...none, askRepo: repo.root };
    if (repo.decision === "deny" || rt.tier !== "local") return none;
    rt.noteTouch([{ kind: "path", value: repo.root }]);
    const r = await rt.search(repo.root, query, { limit: 20, budgetMs });
    return { tier: r.tier, backend: rt.backend, hits: r.hits };
  } catch {
    return none;
  }
}
