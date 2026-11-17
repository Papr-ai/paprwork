/**
 * papr-code-harness v1.1 — evidence fusion of papr-embed (Papr Memory code search) and a lightweight code graph.
 *
 * papr-embed finds the right area; the graph re-ranks inside it. Per file:
 *   score = dense                                   memory score, min-max normalised over the hits (0..1)
 *         + W_DEF  * min(#symbols it defines, 2)    symbols from the grep pattern / query; ignored when a name is
 *                                                   defined in more than MAX_DEF_FILES files (generic names say nothing)
 *         + W_LINK * Σ dense(q) / √deg(q)           papr-embed files q it imports / that import it; hubs pass nothing
 *         + W_NEAR * dense(f)                       when f is linked to a file defining one of the symbols
 * Links pass through re-export files (index.ts, __init__.py) up to 2 hops; re-exports, tests and docs never rank.
 * Same algorithm and weights as swebench-harness/harness/fusion.py (replayed on 348 SWE-bench Pro tasks:
 * recall@3 42.6% → 44.9%, recall@10 60.7% → 63.7%).
 */
import * as path from "path";

export const W_DEF = 0.5;
export const W_LINK = 0.3;
export const W_NEAR = 0.2;
const MAX_DEF_FILES = 3;
const MAX_DEG = 25;
const REEXPORT_HOPS = 2;

export const SKIP_PATH =
  /(^|\/)(tests?|testing|__tests__|testdata|e2e|mocks?|fixtures?|node_modules|dist)\/|(^|\/)test_[^/]*$|_tests?\.py$|conftest\.py$|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)docs?\/|(^|\/)migrations?\//;
const JS_EXT = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];
const JS_IMPORT = /(?:require\(\s*|from\s+|import\s+|export\s+\*\s+from\s+)['"]([^'"]+)['"]/g;
const PY_IMPORT = /^\s*(?:from\s+(\.*[\w.]*)\s+import\s+([\w, ()*]+)|import\s+([\w., ]+))/gm;
const STOP = new Set(
  "this that with from when should will must have been only also into each then than which while where what true false null none self string number object array value values return returns error errors function method class module file files data type types test tests issue example expected current".split(
    " ",
  ),
);

export interface SourceFile {
  path: string;
  text: string;
}
export interface Definition {
  path: string;
  l0: number;
  l1: number;
  name: string;
}
export interface FusedHit {
  path: string;
  score: number;
  why: string[];
  /** Definition of a query symbol in this file (where to point), if any. */
  def?: Definition;
}

const isJs = (p: string) => JS_EXT.some((e) => p.endsWith(e));

/** Function / class / method definitions with line ranges (brace or indent matched). Regex, no parser dependency. */
export function extractDefinitions(files: SourceFile[]): Map<string, Definition[]> {
  const defs = new Map<string, Definition[]>();
  const add = (d: Definition) => {
    const list = defs.get(d.name) ?? [];
    list.push(d);
    defs.set(d.name, list);
  };
  for (const f of files) {
    const lines = f.text.split("\n");
    const py = f.path.endsWith(".py");
    const go = f.path.endsWith(".go");
    if (!py && !go && !isJs(f.path)) continue;
    const head = py
      ? /^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/
      : go
        ? /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/
        : /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|(?:[\w$]+\.)+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)|(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$)/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(head);
      if (!m) continue;
      const name = py ? m[2] : m.slice(1).find((x) => x);
      if (!name || ["if", "for", "while", "switch", "catch", "return", "function"].includes(name)) continue;
      let end = i;
      if (py) {
        const indent = m[1].length;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (l.trim() === "") continue;
          if (l.length - l.trimStart().length <= indent) break;
          end = j;
        }
      } else {
        let depth = 0;
        let opened = false;
        for (let j = i; j < lines.length && j < i + 2000; j++) {
          for (const ch of lines[j]) {
            if (ch === "{") {
              depth++;
              opened = true;
            } else if (ch === "}") depth--;
          }
          end = j;
          if (opened && depth <= 0) break;
          if (!opened && j > i + 2) break;
        }
      }
      add({ path: f.path, l0: i + 1, l1: end + 1, name });
    }
  }
  return defs;
}

function resolveJs(from: string, spec: string, paths: Set<string>): string | undefined {
  let base: string;
  if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else if (spec.startsWith("src/") || spec.startsWith("~/")) base = path.posix.normalize(spec.replace(/^~\//, "src/"));
  else return undefined;
  const cands = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
  return cands.find((c) => paths.has(c));
}

/** {path: imported paths} for JS/TS (relative + src/ alias), Python (absolute + relative) and Go (package dirs). */
export function importEdges(files: SourceFile[]): Map<string, Set<string>> {
  const paths = new Set(files.map((f) => f.path));
  const pymod = new Map<string, string>();
  const godir = new Map<string, Set<string>>();
  for (const p of paths) {
    if (p.endsWith(".py")) {
      const parts = p.slice(0, -3).split("/");
      if (parts[parts.length - 1] === "__init__") parts.pop();
      for (let k = 0; k < parts.length; k++) {
        const key = parts.slice(k).join(".");
        if (!pymod.has(key)) pymod.set(key, p);
      }
    } else if (p.endsWith(".go")) {
      const d = path.posix.dirname(p);
      if (!godir.has(d)) godir.set(d, new Set());
      godir.get(d)!.add(p);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const e = new Set<string>();
    if (isJs(f.path)) {
      for (const m of f.text.matchAll(JS_IMPORT)) {
        const r = resolveJs(f.path, m[1], paths);
        if (r) e.add(r);
      }
    } else if (f.path.endsWith(".py")) {
      for (const m of f.text.matchAll(PY_IMPORT)) {
        const [, mod, names, plain] = m;
        if (mod) {
          let base = mod;
          if (mod.startsWith(".")) {
            const dots = mod.length - mod.replace(/^\.+/, "").length;
            const pkg = path.posix.dirname(f.path).split("/").filter(Boolean);
            const kept = dots > 1 ? pkg.slice(0, pkg.length - (dots - 1)) : pkg;
            base = [...kept, ...(mod.replace(/^\.+/, "") ? [mod.replace(/^\.+/, "")] : [])].join(".");
          }
          const subs = names.split(/[,()\s]+/).filter((n) => n && n !== "*");
          for (const key of [base, ...subs.map((n) => `${base}.${n}`)]) {
            const hit = pymod.get(key);
            if (hit) e.add(hit);
          }
        } else if (plain) {
          for (const part of plain.split(",")) {
            const hit = pymod.get(part.trim().split(" ")[0]);
            if (hit) e.add(hit);
          }
        }
      }
    } else if (f.path.endsWith(".go")) {
      for (const q of godir.get(path.posix.dirname(f.path)) ?? []) e.add(q);
      const block = f.text.match(/import\s*\(([\s\S]*?)\)/);
      const imps = block
        ? [...block[1].matchAll(/"([\w./-]+)"/g)].map((x) => x[1])
        : [...f.text.matchAll(/import\s+"([^"]+)"/g)].map((x) => x[1]);
      for (const imp of imps) {
        for (const [d, fs] of godir) {
          if (d && d !== "." && imp.endsWith("/" + d)) {
            for (const q of fs) e.add(q);
            break;
          }
        }
      }
    }
    e.delete(f.path);
    out.set(f.path, e);
  }
  return out;
}

/** index.* / __init__.py whose code lines are (almost) all imports or exports. */
export function isReexport(p: string, text: string): boolean {
  const name = p.split("/").pop() ?? "";
  if (!name.startsWith("index.") && name !== "__init__.py") return false;
  const code = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(\/\/|#|\*|\/\*|['"]use strict['"])/.test(l));
  if (code.length === 0) return true;
  const io = code.filter((l) =>
    /^(import |export |from |module\.exports|exports\.|(const|let|var) [\w$]+ = (require|module\.exports)|[\w$]+\.[\w$]+ = require|__all__|\}|\]|\)|[\w$]+,?$)/.test(
      l,
    ),
  ).length;
  return io >= 0.8 * code.length;
}

/** Undirected file links that pass through re-export files. */
export class Links {
  private nb = new Map<string, Set<string>>();
  private cache = new Map<string, Set<string>>();
  constructor(
    edges: Map<string, Set<string>>,
    readonly reexports: Set<string>,
  ) {
    const link = (a: string, b: string) => {
      if (!this.nb.has(a)) this.nb.set(a, new Set());
      this.nb.get(a)!.add(b);
    };
    for (const [a, bs] of edges) for (const b of bs) (link(a, b), link(b, a));
  }

  of(p: string): Set<string> {
    const hit = this.cache.get(p);
    if (hit) return hit;
    const out = new Set<string>();
    const seen = new Set([p]);
    let front = new Set([p]);
    for (let hop = 0; hop <= REEXPORT_HOPS && front.size; hop++) {
      const next = new Set<string>();
      for (const f of front) {
        for (const q of this.nb.get(f) ?? []) {
          if (seen.has(q)) continue;
          seen.add(q);
          if (this.reexports.has(q)) next.add(q);
          else if (!SKIP_PATH.test(q)) out.add(q);
        }
      }
      front = next;
    }
    this.cache.set(p, out);
    return out;
  }
}

/** Identifiers named in free text: `backticked`, camelCase, PascalCase with an inner capital, snake_case, a.b() chains. */
export function textSymbols(text: string): Set<string> {
  const toks = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$.]*)(?:\(\))?`/g)) toks.add(m[1]);
  for (const m of text.matchAll(/\b([a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) toks.add(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\(/g)) toks.add(m[1]);
  const out = new Set<string>();
  for (const t of toks) for (const part of t.split(".")) if (part.length >= 4 && !STOP.has(part.toLowerCase())) out.add(part);
  return out;
}

/** Fuse papr-embed scores with the graph into one ranked list (best first). */
export function fuse(
  dense: Map<string, number>,
  defs: Map<string, Definition[]>,
  links: Links,
  symbols: Iterable<string>,
  k = 10,
): FusedHit[] {
  const ds = [...dense].filter(([p]) => !SKIP_PATH.test(p));
  const lo = Math.min(...ds.map(([, s]) => s));
  const hi = Math.max(...ds.map(([, s]) => s));
  const norm = new Map(ds.map(([p, s]) => [p, hi > lo ? (s - lo) / (hi - lo) : 1]));
  const score = new Map<string, number>();
  const why = new Map<string, string[]>();
  const hit = new Map<string, Definition>();
  const bump = (p: string, v: number, reason?: string) => {
    score.set(p, (score.get(p) ?? 0) + v);
    if (reason) why.set(p, [...(why.get(p) ?? []), reason]);
  };
  for (const [p, s] of norm) bump(p, s, `papr-embed ${s.toFixed(2)}`);
  const count = new Map<string, string[]>();
  for (const sym of symbols) {
    const ds_ = (defs.get(sym) ?? []).filter((d) => !SKIP_PATH.test(d.path));
    const files = new Set(ds_.map((d) => d.path));
    if (files.size === 0 || files.size > MAX_DEF_FILES) continue;
    for (const d of ds_) {
      const cur = hit.get(d.path);
      if (!cur || d.l1 - d.l0 < cur.l1 - cur.l0) hit.set(d.path, d);
    }
    for (const f of files) count.set(f, [...(count.get(f) ?? []), sym]);
  }
  for (const [f, names] of count) bump(f, W_DEF * Math.min(names.length, 2), `defines ${names.slice(0, 2).join(", ")}`);
  for (const [p, s] of norm) {
    const ns = links.of(p);
    if (ns.size === 0 || ns.size > MAX_DEG) continue;
    const w = (W_LINK * s) / Math.sqrt(ns.size);
    for (const q of ns) bump(q, w, s >= 0.5 ? `linked to ${p.split("/").pop()}` : undefined);
  }
  for (const f of count.keys()) for (const q of links.of(f)) if (norm.has(q)) bump(q, W_NEAR * norm.get(q)!);
  return [...score.keys()]
    .filter((p) => !links.reexports.has(p) && !SKIP_PATH.test(p))
    .sort((a, b) => score.get(b)! - score.get(a)!)
    .slice(0, k)
    .map((p) => ({ path: p, score: score.get(p)!, why: [...new Set(why.get(p) ?? [])].slice(0, 3), def: hit.get(p) }));
}

/** Build the graph for a project's source files and fuse papr-embed hits into ≤k pointers. */
export function fuseProject(files: SourceFile[], dense: Map<string, number>, queryText: string, k = 5): FusedHit[] {
  const src = files.filter((f) => !SKIP_PATH.test(f.path));
  const links = new Links(importEdges(src), new Set(src.filter((f) => isReexport(f.path, f.text)).map((f) => f.path)));
  return fuse(dense, extractDefinitions(src), links, textSymbols(queryText), k);
}

// ---------------------------------------------------------------- Paprwork wiring (hybrid grep in bash.ts)
const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go"];
const MAX_FILES = 3000;
const MAX_BYTES = 400_000;

/** Source files under a project dir (skips node_modules, dist, venvs, tests). */
export async function readProjectSources(root: string): Promise<SourceFile[]> {
  const fs = await import("fs/promises");
  const out: SourceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || ["node_modules", "dist", "venv", ".venv", "__pycache__", "build"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (SOURCE_EXT.some((x) => e.name.endsWith(x))) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (SKIP_PATH.test(rel)) continue;
        try {
          const st = await fs.stat(full);
          if (st.size > MAX_BYTES) continue;
          out.push({ path: rel, text: await fs.readFile(full, "utf8") });
        } catch {
          /* unreadable file: skip */
        }
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * Re-rank Papr Memory code hits for one project with the graph and format ≤3 pointers
 * ("path:l0-l1  symbol  (why)"). Returns "" when nothing clears the bar, so the caller keeps its old output.
 */
export async function fusedPointers(
  projectRoot: string,
  memoryHits: Array<{ path: string; score: number }>,
  queryText: string,
  max = 3,
): Promise<string> {
  if (memoryHits.length === 0) return "";
  const files = await readProjectSources(projectRoot);
  if (files.length === 0) return "";
  const known = new Set(files.map((f) => f.path));
  const dense = new Map<string, number>();
  for (const h of memoryHits) {
    const rel = path.isAbsolute(h.path) ? path.relative(projectRoot, h.path).split(path.sep).join("/") : h.path;
    if (known.has(rel)) dense.set(rel, Math.max(dense.get(rel) ?? -Infinity, h.score));
  }
  if (dense.size === 0) return "";
  const top = fuseProject(files, dense, queryText, max);
  const lines = top.map((h) => {
    const span = h.def ? `:${h.def.l0}-${h.def.l1}  ${h.def.name}` : "";
    return `${h.path}${span}  (${h.why.join("; ")})`;
  });
  return lines.length ? `=== Code pointers (papr-embed + code graph) ===\n${lines.join("\n")}\n` : "";
}
