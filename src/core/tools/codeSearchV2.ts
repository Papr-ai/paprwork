/**
 * papr-code-search v2 — the pointer block hybrid grep shows for Papr apps/jobs.
 *
 * v1.1 (codeFusion.ts) re-ranks Papr Memory code hits with a code graph: the top MAX_POINTERS lead the output with
 * line ranges. v2 adds up to MAX_ALSO "also check" files that the semantic search could not reach, found by
 * codeCandidates.ts (files the command names and what they load, SQL table users, wiki entity pages, doc -> code
 * mentions, definitions + callers, exact-word search), each with the reason it was added.
 *
 * Grep output and the semantic list are never changed or reordered. Every step fails closed: any error returns ""
 * and the caller keeps its previous output.
 */
import * as path from "path";
import {
  Links,
  extractDefinitions,
  fuse,
  importEdges,
  isReexport,
  textSymbols,
  SKIP_PATH,
  type SourceFile,
} from "./codeFusion.js";
import {
  Repo,
  candidates,
  fuseRanked,
  type CandidateSource,
} from "./codeCandidates.js";

export const MAX_POINTERS = 3;
export const MAX_ALSO = 2;
const TEXT_EXT = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".md",
  ".html",
  ".css",
  ".json",
  ".sql",
  ".sh",
];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "venv",
  ".venv",
  "__pycache__",
  "build",
  ".versions",
  ".git",
  "data",
]);
const MAX_FILES = 3000;
const MAX_BYTES = 400_000;
const CACHE_TTL_MS = 60_000;
const SOURCE_LABEL: Record<CandidateSource, string> = {
  dense: "papr-embed",
  bm25: "exact words",
  anchor: "named in your command",
  anchor_dir: "next to the file in your command",
  load: "loaded by the file in your command",
  graph: "defines a searched symbol",
  table: "queries a table you named",
  entity: "wiki page for a name you used",
  mention: "named in a related doc",
};

interface Corpus {
  at: number;
  files: SourceFile[];
  repo: Repo;
}
const cache = new Map<string, Corpus>();

/** Text files under each root; paths are root-relative, extra roots are prefixed with their label ("workspace/..."). */
export async function readCorpus(
  roots: Array<{ dir: string; prefix: string }>,
): Promise<SourceFile[]> {
  const fs = await import("fs/promises");
  const out: SourceFile[] = [];
  const walk = async (
    root: string,
    dir: string,
    prefix: string,
  ): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(root, full, prefix);
        continue;
      }
      if (
        !TEXT_EXT.some((x) => e.name.endsWith(x)) ||
        /lock|\.min\./.test(e.name)
      )
        continue;
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_BYTES) continue;
        out.push({
          path: prefix + path.relative(root, full).split(path.sep).join("/"),
          text: await fs.readFile(full, "utf8"),
        });
      } catch {
        /* unreadable: skip */
      }
    }
  };
  for (const r of roots) await walk(r.dir, r.dir, r.prefix);
  return out;
}

async function corpusFor(
  projectRoot: string,
  workspaceEntities?: string,
): Promise<Corpus> {
  const key = `${projectRoot}|${workspaceEntities ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const roots = [{ dir: projectRoot, prefix: "" }];
  if (workspaceEntities)
    roots.push({ dir: workspaceEntities, prefix: "workspace/entities/" });
  const files = await readCorpus(roots);
  const c = { at: Date.now(), files, repo: new Repo(files) };
  if (cache.size > 20) cache.delete(cache.keys().next().value as string);
  cache.set(key, c);
  return c;
}

export interface PointerInput {
  projectRoot: string;
  /** Papr Memory hits (absolute or root-relative path + score), best first. May be empty. */
  memoryHits: Array<{ path: string; score: number }>;
  /** Semantic query sent to Papr Memory (grep pattern + project). */
  query: string;
  /** The agent's full shell command (anchors: files it names). */
  command: string;
  pattern: string;
  /** Files grep already printed; they are not repeated as pointers. */
  grepHits?: string[];
  workspaceEntitiesDir?: string;
}

/**
 * Pure ranking over an in-memory corpus (exported for tests).
 *  - pointers: the papr-embed hits re-ranked by the code graph (v1.1, unchanged), top MAX_POINTERS.
 *  - alsoCheck: up to MAX_ALSO files papr-embed did not return, from the candidate sources (fused by weighted RRF).
 * Replay (Curation Bench, 50 grep misses + 25 controls): memory's 10 alone find the needed file for 44/50 + 17/25;
 * adding 2 such files finds 47/50 + 17/25. Re-ranking or capping memory's list with the sources did not help.
 */
export function rankPointers(
  files: SourceFile[],
  repo: Repo,
  input: Omit<PointerInput, "projectRoot" | "workspaceEntitiesDir">,
  max = MAX_POINTERS,
): { pointers: RankedPointer[]; alsoCheck: RankedPointer[] } {
  const known = new Set(files.map((f) => f.path));
  const dense = new Map<string, number>();
  for (const h of input.memoryHits) {
    const rel = h.path.replace(/\\/g, "/");
    const match = known.has(rel)
      ? rel
      : [...known].find((k) => rel.endsWith(`/${k}`));
    if (match)
      dense.set(match, Math.max(dense.get(match) ?? -Infinity, h.score));
  }
  const src = files.filter(
    (f) => !SKIP_PATH.test(f.path) && !f.path.startsWith("workspace/"),
  );
  const defs = extractDefinitions(src);
  const symbols = [
    ...new Set([
      ...textSymbols(`${input.pattern} ${input.query}`),
      ...textSymbols(input.command),
    ]),
  ];
  if (/^[A-Za-z_$][\w$]{3,}$/.test(input.pattern))
    symbols.unshift(input.pattern);
  const links = new Links(
    importEdges(src),
    new Set(src.filter((f) => isReexport(f.path, f.text)).map((f) => f.path)),
  );
  const v11 = dense.size ? fuse(dense, defs, links, symbols, 20) : [];
  const grepHits = [...(input.grepHits ?? [])];
  const already = (p: string) =>
    grepHits.some((g) => g === p || g.endsWith(`/${p}`) || p.endsWith(`/${g}`));
  const pointers = v11
    .filter((h) => !already(h.path))
    .slice(0, max)
    .map((h) => ({ path: h.path, def: h.def, why: h.why }));
  // Everything memory returned counts as "already reached" (it is listed below the pointers anyway).
  const reached = new Set([...dense.keys(), ...v11.map((h) => h.path)]);
  const cands = candidates(
    repo,
    [...reached],
    input.command,
    `${input.pattern} ${input.query}`,
    symbols,
    defs,
  );
  const alsoCheck = fuseRanked([], cands, 40)
    .filter(
      (r) =>
        !reached.has(r.path) &&
        !already(r.path) &&
        !SKIP_PATH.test(r.path) &&
        // workspace/entities pages only when a name in the search matched the page
        (!r.path.startsWith("workspace/") || r.sources.includes("entity")),
    )
    .slice(0, MAX_ALSO)
    .map((r) => ({ path: r.path, why: r.sources.map((s) => SOURCE_LABEL[s]) }));
  return { pointers, alsoCheck };
}

export interface RankedPointer {
  path: string;
  why: string[];
  def?: { l0: number; l1: number; name: string };
}

const line = (h: RankedPointer) =>
  `${h.path}${h.def ? `:${h.def.l0}-${h.def.l1}  ${h.def.name}` : ""}  (${h.why.join("; ")})`;

/** The block shown with grep output, or "" when nothing ranks / anything fails. */
export async function codePointerBlock(input: PointerInput): Promise<string> {
  // The sources only ADD to the papr-embed list (as in the replay). Without memory hits they found the needed file
  // for 9 of 50 misses in a top 5, mostly noise, so nothing is shown.
  if (input.memoryHits.length === 0) return "";
  try {
    const { files, repo } = await corpusFor(
      input.projectRoot,
      input.workspaceEntitiesDir,
    );
    if (files.length === 0) return "";
    const { pointers, alsoCheck } = rankPointers(files, repo, input);
    if (pointers.length === 0 && alsoCheck.length === 0) return "";
    let out =
      "=== Code pointers (papr-code-search v2: papr-embed + code graph) ===\n";
    out += pointers.map(line).join("\n");
    if (alsoCheck.length)
      out += `${pointers.length ? "\n" : ""}also check (not in the semantic results):\n${alsoCheck.map(line).join("\n")}`;
    return `${out}\n`;
  } catch (e) {
    console.warn(
      "[Bash Tool] code pointers skipped:",
      (e as Error)?.message ?? e,
    );
    return "";
  }
}

/** For tests: drop cached corpora. */
export function clearCorpusCache(): void {
  cache.clear();
}

/** Pointers for a grep inside one Papr app/job (called from bash.ts). "" when the path names no project or on error. */
export async function codePointersForGrep(
  grepPath: string,
  command: string,
  pattern: string,
  query: string,
  memoryHits: Array<{ path: string; score: number }>,
  grepStdout: string,
): Promise<string> {
  try {
    const projectId = grepPath.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )?.[0];
    if (!projectId) return "";
    const [{ grepHitFiles }, roots, fsMod] = await Promise.all([
      import("./codeSearchGrepHits.js"),
      import("../utils/paprRoot.js"),
      import("fs"),
    ]);
    const projectRoot = [roots.getPaprAppsRoot(), roots.getPaprJobsRoot()]
      .map((r) => path.join(r, projectId))
      .find((r) => fsMod.existsSync(r));
    if (!projectRoot) return "";
    const entities = path.join(roots.getPaprWorkspaceDir(), "entities");
    // Index paths come in several layouts (~/Papr/apps/<id>/…, ~/PAPR/apps/…, …/orgs/…/namespaces/…/apps/<id>/…):
    // cut on the project id, not on today's root.
    const rel = (p: string) => {
      const n = p.replace(/\\/g, "/");
      const k = n.indexOf(`/${projectId}/`);
      if (k >= 0) return n.slice(k + projectId.length + 2);
      return path.isAbsolute(p)
        ? path.relative(projectRoot, p).split(path.sep).join("/")
        : p;
    };
    return await codePointerBlock({
      projectRoot,
      memoryHits: memoryHits.map((h) => ({ ...h, path: rel(h.path) })),
      query,
      command,
      pattern,
      grepHits: grepHitFiles(grepStdout).map(rel),
      workspaceEntitiesDir: fsMod.existsSync(entities) ? entities : undefined,
    });
  } catch (e) {
    console.warn(
      "[Bash Tool] code pointers skipped:",
      (e as Error)?.message ?? e,
    );
    return "";
  }
}
