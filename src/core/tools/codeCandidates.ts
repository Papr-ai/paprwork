/**
 * papr-code-search v2 — candidate sources beyond papr-embed for hybrid grep.
 *
 * Curation Bench replay (Nov 10 2026, 50 hand-graded grep misses + 25 controls): papr-embed alone missed files it
 * had no way to reach — a script loaded by the file the agent was reading, the file that queries a SQL table, a wiki
 * entity page named in the question, an exact name only lexical search sees. Each source below adds those files;
 * they are fused with the papr-embed ranking by weighted reciprocal rank (fuseRanked), so a source can lift a file
 * but never removes one papr-embed ranked. Same rules as swebench-harness curation_replay/data/candgen.py.
 *
 *   bm25        lexical top 20 over path + text: exact names, people, table names, symbols
 *   anchor      files the command itself names (`sed -n 1,9p public/apps/x/foo.js` -> that file)
 *   anchor_dir  files in an anchor's folder that share >= 2 query words
 *   load        files an anchor loads: <script src>, import/require, fetch()/xhr GET of a local file
 *   graph       definitions of symbols named in the search (code graph)
 *   table       files whose SQL (SELECT/INSERT/UPDATE/DELETE/CREATE TABLE lines) touches a table named in the search
 *   entity      wiki entity pages (entities/{people,companies,apps,projects}/<slug>.md) whose name is in the search
 *   mention     code files a top doc names by file name, and docs that name an anchor file
 */
import * as path from "path";
import type { Definition, SourceFile } from "./codeFusion.js";

export type CandidateSource =
  | "dense"
  | "bm25"
  | "anchor"
  | "anchor_dir"
  | "load"
  | "graph"
  | "table"
  | "entity"
  | "mention";

export interface Candidate {
  path: string;
  source: CandidateSource;
}

/** Weighted RRF. Chosen offline on the replay: top-10 hit 61/75 -> 62/75, no row lost (dense = papr-embed order). */
export const SOURCE_WEIGHT: Record<CandidateSource, number> = {
  dense: 1,
  anchor: 1,
  anchor_dir: 0.5,
  bm25: 0.5,
  entity: 0.5,
  load: 0.3,
  graph: 0.3,
  mention: 0.3,
  table: 0.2,
};
export const RRF_K = 60;

const STOP = new Set(
  "the and for with from that this what which where when does how why are was were into onto its use used using file files code function section data app apps page document documents doc docs update show find search grep include".split(
    " ",
  ),
);
const LOAD =
  /(?:src|href)\s*=\s*["']([^"'#?]+)|(?:import|export)\s[^'"]*?from\s*["']([^"']+)|require\(\s*["']([^"']+)|import\(\s*["']([^"']+)|fetch\(\s*["'`]([^"'`?]+)|\.open\(\s*["']GET["']\s*,\s*["']([^"']+)/g;
const TABLE =
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+[`"']?([A-Za-z_][A-Za-z0-9_]{2,})/g;
const SQL_LINE = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/;
const ENTITY = /(^|\/)entities\/(people|companies|apps|projects)\/([^/]+)\.md$/;
const CMD_FILE =
  /[\w./@-]+\.(?:py|ts|tsx|js|jsx|mjs|json|md|html|css|sql|sh|go)\b/g;
const MENTION = /[\w-]+\.(?:py|ts|tsx|js|jsx|mjs|sql|go)\b/g;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go)$/;
const ENTITY_FILLER = new Set(["inc", "the", "and", "ai"]);
const ENTITY_OK = new Set(["ventures", "capital", "labs", "manager"]);
const TEXT_CAP = 30_000;

export function toks(s: string): string[] {
  const words =
    s
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  return words.filter((w) => w.length > 2 && !STOP.has(w));
}

const count = (ws: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
};

/** Per-project lexical index + link edges. Build once per corpus (cheap: no parsing, regex only). */
export class Repo {
  readonly paths: string[];
  readonly text = new Map<string, string>();
  readonly byBase = new Map<string, string[]>();
  readonly tables = new Map<string, Set<string>>();
  readonly entities = new Map<string, Set<string>>();
  private readonly tf: Map<string, number>[];
  private readonly len: number[];
  private readonly avg: number;
  private readonly df = new Map<string, number>();

  constructor(files: SourceFile[]) {
    this.paths = files.map((f) => f.path);
    for (const f of files) {
      this.text.set(f.path, f.text);
      const b = path.posix.basename(f.path);
      this.byBase.set(b, [...(this.byBase.get(b) ?? []), f.path]);
    }
    this.tf = files.map((f) =>
      count([
        ...toks(f.path),
        ...toks(f.path),
        ...toks(f.path),
        ...toks(f.text.slice(0, TEXT_CAP)),
      ]),
    );
    this.len = this.tf.map(
      (c) => [...c.values()].reduce((a, b) => a + b, 0) || 1,
    );
    this.avg =
      this.len.reduce((a, b) => a + b, 0) / Math.max(this.len.length, 1);
    for (const c of this.tf)
      for (const w of c.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    for (const f of files) {
      for (const line of f.text.slice(0, 200_000).split("\n")) {
        if (!SQL_LINE.test(line)) continue;
        for (const m of line.matchAll(TABLE)) {
          const t = m[1].toLowerCase();
          this.tables.set(t, (this.tables.get(t) ?? new Set()).add(f.path));
        }
      }
      const e = ENTITY.exec(f.path);
      if (e)
        this.entities.set(
          f.path,
          new Set(
            e[3]
              .toLowerCase()
              .split("-")
              .filter((w) => !ENTITY_FILLER.has(w)),
          ),
        );
    }
  }

  bm25(query: string, k = 20): string[] {
    const qt = [...new Set(toks(query))].filter((w) => this.df.has(w));
    if (qt.length === 0) return [];
    const n = this.paths.length;
    const idf = new Map(
      qt.map((w) => [
        w,
        Math.log(1 + (n - this.df.get(w)! + 0.5) / (this.df.get(w)! + 0.5)),
      ]),
    );
    const scored: Array<[number, string]> = [];
    this.tf.forEach((c, i) => {
      let s = 0;
      for (const [w, v] of idf) {
        const f = c.get(w);
        if (f)
          s +=
            (v * f * 2.2) /
            (f + 1.2 * (0.25 + (0.75 * this.len[i]) / this.avg));
      }
      if (s > 0) scored.push([s, this.paths[i]]);
    });
    return scored
      .sort((a, b) => b[0] - a[0])
      .slice(0, k)
      .map(([, p]) => p);
  }

  /** Resolve a reference written inside `from` (relative, root-absolute, or extensionless) to a corpus path. */
  resolve(ref: string, from: string): string | undefined {
    const r = ref.split("?")[0].trim();
    if (!r || /^(https?:|\/\/|data:|#)/.test(r)) return undefined;
    const cand = r.startsWith("/")
      ? r.slice(1)
      : path.posix.normalize(path.posix.join(path.posix.dirname(from), r));
    for (const c of [
      cand,
      ...[".js", ".ts", ".tsx", ".py", "/index.js", "/index.ts"].map(
        (x) => cand + x,
      ),
    ]) {
      if (this.text.has(c)) return c;
    }
    return (this.byBase.get(path.posix.basename(r)) ?? []).find(
      (p) => path.posix.dirname(p) === path.posix.dirname(from),
    );
  }

  loads(p: string): string[] {
    const out: string[] = [];
    for (const m of (this.text.get(p) ?? "").slice(0, 200_000).matchAll(LOAD)) {
      const ref = m.slice(1).find((x) => x);
      const t = ref ? this.resolve(ref, p) : undefined;
      if (t && t !== p && !out.includes(t)) out.push(t);
    }
    return out;
  }

  /** Files the command names by path tail; a bare name counts only when it is unambiguous (<= 2 files). */
  anchors(command: string): string[] {
    const out: string[] = [];
    for (const m of command.matchAll(CMD_FILE)) {
      const ref = m[0].replace(/^\.\//, "");
      const same = this.byBase.get(path.posix.basename(ref)) ?? [];
      const hit = same.filter((p) => p.endsWith(ref) || ref.endsWith(p));
      for (const h of hit.length ? hit : same.length <= 2 ? same : [])
        if (!out.includes(h)) out.push(h);
    }
    return out.slice(0, 8);
  }

  /** doc -> code: code files a doc names by file name (names that resolve to <= 2 files). */
  mentions(p: string, k = 6): string[] {
    const out: string[] = [];
    for (const m of (this.text.get(p) ?? "")
      .slice(0, 100_000)
      .matchAll(MENTION)) {
      const h = this.byBase.get(m[0]) ?? [];
      if (h.length >= 1 && h.length <= 2)
        for (const x of h) if (x !== p && !out.includes(x)) out.push(x);
      if (out.length >= k) break;
    }
    return out.slice(0, k);
  }
}

/** All non-dense candidates for one search, in source order (each source capped). */
export function candidates(
  R: Repo,
  dense: string[],
  command: string,
  query: string,
  symbols: string[],
  defs?: Map<string, Definition[]>,
): Candidate[] {
  const qt = new Set(toks(`${query} ${symbols.join(" ")}`));
  const out: Candidate[] = [];
  const seen = new Set(dense);
  const add = (ps: string[], source: CandidateSource, n = 99) => {
    let c = 0;
    for (const p of ps) {
      if (c >= n) break;
      if (seen.has(p) || !R.text.has(p)) continue;
      seen.add(p);
      out.push({ path: p, source });
      c++;
    }
  };
  add(R.bm25(`${query} ${symbols.join(" ")}`), "bm25", 20);
  const A = R.anchors(command);
  add(A, "anchor", 8);
  for (const a of A) add(R.loads(a), "load", 6);
  const dirs = new Set(A.map((a) => path.posix.dirname(a)));
  const overlap = (p: string) =>
    toks(
      `${path.posix.basename(p)} ${(R.text.get(p) ?? "").slice(0, 4000)}`,
    ).filter((w) => qt.has(w));
  const near = R.paths
    .filter(
      (p) => dirs.has(path.posix.dirname(p)) && new Set(overlap(p)).size >= 2,
    )
    .sort((a, b) => new Set(overlap(b)).size - new Set(overlap(a)).size);
  add(near, "anchor_dir", 8);
  if (defs) {
    // definitions + callers (files that call the symbol), as code_graph.lookup(max_callers=6) in the replay
    for (const s of symbols) {
      const d = (defs.get(s) ?? []).slice(0, 3).map((x) => x.path);
      if (d.length === 0) continue;
      const call = new RegExp(`\\b${s.replace(/\$/g, "\\$")}\\s*\\(`);
      const callers = R.paths.filter(
        (p) =>
          !d.includes(p) && CODE_FILE.test(p) && call.test(R.text.get(p) ?? ""),
      );
      add([...d, ...callers], "graph", 9);
    }
  }
  for (const w of qt) {
    const t = R.tables.get(w) ?? R.tables.get(w.replace(/s$/, ""));
    if (t) add([...t].sort().slice(0, 6), "table", 6);
  }
  const ents = [...R.entities].filter(
    ([, name]) =>
      name.size > 0 &&
      [...name].every((w) => qt.has(w) || ENTITY_OK.has(w)) &&
      [...name].some((w) => qt.has(w)),
  );
  add(
    ents.map(([p]) => p),
    "entity",
    4,
  );
  for (const p of [
    ...dense.slice(0, 10),
    ...out.slice(0, 10).map((c) => c.path),
  ]) {
    if (/\.(md|txt)$/.test(p)) add(R.mentions(p), "mention", 3);
  }
  for (const a of A) {
    const name = path.posix.basename(a);
    add(
      R.paths
        .filter(
          (p) =>
            p.endsWith(".md") &&
            (R.text.get(p) ?? "").slice(0, 100_000).includes(name),
        )
        .slice(0, 3),
      "mention",
      3,
    );
  }
  return out;
}

export interface RankedFile {
  path: string;
  score: number;
  sources: CandidateSource[];
}

/** Weighted reciprocal-rank fusion of the papr-embed order and the candidate sources. Best first. */
export function fuseRanked(
  dense: string[],
  cands: Candidate[],
  k = 10,
): RankedFile[] {
  const score = new Map<string, number>();
  const sources = new Map<string, CandidateSource[]>();
  const bump = (p: string, rank: number, s: CandidateSource) => {
    score.set(p, (score.get(p) ?? 0) + SOURCE_WEIGHT[s] / (RRF_K + rank + 1));
    sources.set(p, [...(sources.get(p) ?? []), s]);
  };
  dense.slice(0, 20).forEach((p, i) => bump(p, i, "dense"));
  const rankIn = new Map<CandidateSource, number>();
  for (const c of cands) {
    const r = rankIn.get(c.source) ?? 0;
    rankIn.set(c.source, r + 1);
    bump(c.path, r, c.source);
  }
  return [...score]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([p, s]) => ({
      path: p,
      score: s,
      sources: [...new Set(sources.get(p))],
    }));
}
