/**
 * The user's own git repos (outside the Papr Work folder) in the on-device index. Opt-in per repo, asked once.
 *
 *   - Consent lives in <dataDir>/code-embed/repos.json, keyed by the repo's shared git dir, so allowing
 *     ~/Developer/paprwork also covers its worktrees (vectors are keyed by blob sha, so worktrees cost nothing extra).
 *   - Only tracked files are read (`git ls-files`): .gitignore is honoured, node_modules/builds/data never enter.
 *   - iCloud-offloaded files (dataless placeholders) are skipped: reading one would force a download.
 *   - Repo vectors never leave the Mac: they are excluded from cloud sync, and a cloud-tier device does not index repos.
 *
 * PAPR_CODE_EMBED_REPOS=0 turns repo indexing off.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isIndexable, SKIP_DIRS } from "./codeIndexer.js";

export const MAX_REPO_FILES = 15_000;

export function reposEnabled(): boolean {
  return process.env.PAPR_CODE_EMBED_REPOS !== "0";
}

export interface RepoConsent {
  allowed: string[];
  denied: string[];
}

/** One consent file per index (so per org/namespace). Keys are realpaths of each repo's shared git dir. */
export class RepoConsentStore {
  private file: string;
  private cache: RepoConsent | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "code-embed", "repos.json");
  }

  read(): RepoConsent {
    if (this.cache) return this.cache;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.cache = {
        allowed: Array.isArray(j.allowed) ? j.allowed : [],
        denied: Array.isArray(j.denied) ? j.denied : [],
      };
    } catch {
      this.cache = { allowed: [], denied: [] };
    }
    return this.cache;
  }

  /** allow | deny | undefined (never asked). */
  decision(key: string): "allow" | "deny" | undefined {
    const c = this.read();
    if (c.allowed.includes(key)) return "allow";
    if (c.denied.includes(key)) return "deny";
    return undefined;
  }

  set(key: string, allow: boolean): void {
    const c = this.read();
    const next: RepoConsent = {
      allowed: c.allowed.filter((k) => k !== key),
      denied: c.denied.filter((k) => k !== key),
    };
    (allow ? next.allowed : next.denied).push(key);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = next;
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The git work tree containing p (walks up looking for .git), or undefined. Never the home dir or filesystem root
 * itself, and never inside the Papr Work folder (apps/, Jobs/, repos/ have their own roots).
 */
export function repoRootFor(p: string, paprRoot?: string): string | undefined {
  let dir = path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  const home = path.resolve(os.homedir());
  const papr = paprRoot ? path.resolve(paprRoot) : undefined;
  for (let i = 0; i < 40; i++) {
    if (papr && (dir === papr || dir.startsWith(papr + path.sep)))
      return undefined;
    if (dir === home || dir === path.dirname(dir)) return undefined;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

/** Consent key for a work tree: the shared git dir (a worktree's .git file points into <main>/.git/worktrees/<n>). */
export function repoKey(root: string): string {
  const dotGit = path.join(root, ".git");
  try {
    if (fs.statSync(dotGit).isFile()) {
      const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
      if (m) {
        const gitdir = path.resolve(root, m[1]!.trim());
        const at = gitdir.split(path.sep).lastIndexOf("worktrees");
        return real(
          at > 0 ? gitdir.split(path.sep).slice(0, at).join(path.sep) : gitdir,
        );
      }
    }
  } catch {}
  return real(dotGit);
}

/** An iCloud-offloaded placeholder: has a size but no blocks on disk. Reading it would download it. */
export function isDataless(st: fs.Stats): boolean {
  return process.platform === "darwin" && st.size > 0 && st.blocks === 0;
}

/** Tracked, indexable files of a repo (git ls-files), skipping build/vendor dirs, secrets and offloaded files. */
export function gitListFiles(
  root: string,
  run: (root: string) => string = defaultLsFiles,
): Array<{ rel: string; abs: string; mtimeMs: number; size: number }> {
  let out: string;
  try {
    out = run(root);
  } catch {
    return [];
  }
  const files: Array<{
    rel: string;
    abs: string;
    mtimeMs: number;
    size: number;
  }> = [];
  for (const rel of out.split("\0")) {
    if (!rel || files.length >= MAX_REPO_FILES) continue;
    const segs = rel.split("/");
    if (
      segs.some(
        (s) => SKIP_DIRS.has(s) || (s.startsWith(".") && s !== ".github"),
      )
    )
      continue;
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || isDataless(st) || !isIndexable(rel, st.size)) continue;
    files.push({ rel, abs, mtimeMs: st.mtimeMs, size: st.size });
  }
  return files;
}

function defaultLsFiles(root: string): string {
  return execFileSync("git", ["-C", root, "ls-files", "-z", "--cached"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}
