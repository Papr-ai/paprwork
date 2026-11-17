/**
 * Non-code folders of the Papr Work folder the on-device index also covers: documents/ (Papr Docs), workspace/
 * (IDENTITY.md, wiki entities, memory notes, brand) and each repo under repos/. Each is one index root.
 *
 * Unlike apps/ and Jobs/ (added on the first agent grep), these are adopted at startup: they are small (a few MB of
 * markdown) and the agent rarely greps them by path, so waiting for a grep would leave them unindexed.
 *
 * PAPR_CODE_EMBED_CONTEXT=0 turns this off (apps/ and Jobs/ keep working).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CONTEXT_DIRS = ["documents", "workspace", "repos"] as const;

export interface ExtraSkip {
  dirs: Set<string>;
  file?: RegExp;
}

/** documents/<slug>/versions/ are old copies of content.md and meta.json is bookkeeping: both would only add noise. */
const DOCUMENTS_SKIP: ExtraSkip = { dirs: new Set(["versions"]), file: /(^|\/)meta\.json$/i };

export function contextEnabled(): boolean {
  return process.env.PAPR_CODE_EMBED_CONTEXT !== "0";
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Existing context roots: documents/, workspace/ and every repos/<name>/. */
export function contextRoots(paprRoot: string): string[] {
  const out = ["documents", "workspace"].map((d) => path.join(paprRoot, d)).filter(isDir);
  try {
    for (const e of fs.readdirSync(path.join(paprRoot, "repos"), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) out.push(path.join(paprRoot, "repos", e.name));
    }
  } catch {}
  return out;
}

/** Folder-specific skips on top of the indexer's defaults (keyed by the root's own folder name). */
export function contextSkip(root: string): ExtraSkip | undefined {
  return path.basename(root) === "documents" ? DOCUMENTS_SKIP : undefined;
}

/**
 * The context root a file or grep path falls under, or undefined. Accepts an absolute path, ~/…, $PAPR_HOME/… or
 * ${PAPR_HOME}/…, with trailing grep arguments. repos/ alone is not a root: one repo is.
 */
export function contextRootFor(p: string, paprRoot: string): string | undefined {
  const base = paprRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  let n = p.replace(/\\/g, "/").replace(/^["']/, "");
  n = n.replace(/(^|\s|["'=])~\//g, `$1${os.homedir().replace(/\\/g, "/")}/`);
  let rest: string | undefined;
  const at = n.indexOf(`${base}/`);
  if (at >= 0) rest = n.slice(at + base.length + 1);
  else rest = n.match(/\$\{?PAPR_HOME\}?\/(.*)$/)?.[1];
  if (rest === undefined) return undefined;
  const seg = rest.split(/[\s"']/)[0]!.split("/").filter(Boolean);
  if (seg[0] === "documents" || seg[0] === "workspace") return path.join(paprRoot, seg[0]);
  if (seg[0] === "repos" && seg[1] && !seg[1].startsWith(".")) return path.join(paprRoot, "repos", seg[1]);
  return undefined;
}
