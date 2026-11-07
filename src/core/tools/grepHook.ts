/**
 * Grep hook: the agent keeps grep. After a repo-wide search over Papr apps/jobs we append at most 3
 * pointers (path, lines, symbol, why) to code that grep did not already show. Grep's own output is never
 * changed or reordered. A Jev yes/no gate decides what is shown; when Jev is unavailable we show nothing
 * rather than guess. Same design as the SWE-bench `hook` arm (Code Agent Harness architecture).
 */

export interface HookCandidate {
  id: string;
  path: string;
  l0?: number;
  l1?: number;
  symbol?: string;
  why: string;
  snippet?: string;
  p?: number;
}

export const HOOK_MAX_SHOWN = 3;
export const HOOK_GATE_THRESHOLD = 0.5;

const SEARCH_BINS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const TEST_OR_DOC =
  /(^|\/)(tests?|testing|__tests__)\/|(^|\/)test_[^/]*$|_tests?\.py$|\.(test|spec)\.[jt]sx?$|conftest\.py$|(^|\/)docs?\/|\.(rst|md|txt)$/;

function splitSegments(command: string): string[][] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((seg): string[] => [...(seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [])])
    .map((argv) => {
      let a: string[] = argv;
      while (a.length && (/^\w+=/.test(a[0]) || ["sudo", "time", "nice", "command"].includes(a[0]))) a = a.slice(1);
      return a[0] === "cd" ? [] : a;
    })
    .filter((a) => a.length > 0);
}

const base = (p: string): string => p.split("/").pop() ?? p;

/** True for searches across many files (recursive grep, rg, git grep, find, xargs grep). False for grep in one file or as a pipe filter. */
export function isRepoWideSearch(command: string): boolean {
  for (const argv of splitSegments(command)) {
    const b = base(argv[0]);
    if (b === "git" && argv[1] === "grep") return true;
    if (b === "rg" || b === "ag" || b === "ack") return true;
    if (b === "find" && argv.some((x) => ["-name", "-iname", "-path", "-regex", "-exec"].includes(x))) return true;
    if (b === "xargs" && argv.slice(1).some((x) => SEARCH_BINS.has(base(x)))) return true;
    if (b === "grep" || b === "egrep" || b === "fgrep") {
      const flags = argv.slice(1).filter((x) => x.startsWith("-") && !x.startsWith("--include") && !x.startsWith("--exclude"));
      if (flags.some((f) => f === "-r" || f === "-R" || f === "--recursive" || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)))) return true;
    }
  }
  return false;
}

const HIT = /^(?:\.\/)?((?:[\w.\-~]+\/)*[\w.\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|css|html|json|sql|md))(?=[:\-]\d+[:\-]|:|$)/;

/** Files named in grep/rg/find output, in order of first appearance. */
export function grepHitFiles(output: string, limit = 400): string[] {
  const seen = new Set<string>();
  for (const line of output.split("\n").slice(0, limit)) {
    const m = HIT.exec(line.trim());
    if (m && !seen.has(m[1])) seen.add(m[1]);
  }
  return [...seen];
}

const sameFile = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** Drop candidates grep already showed, tests/docs, and duplicates; keep order. */
export function filterCandidates(cands: HookCandidate[], grepHits: string[]): HookCandidate[] {
  const out: HookCandidate[] = [];
  for (const c of cands) {
    if (TEST_OR_DOC.test(c.path)) continue;
    if (grepHits.some((h) => sameFile(h, c.path))) continue;
    if (out.some((o) => o.path === c.path && o.symbol === c.symbol)) continue;
    out.push(c);
  }
  return out;
}

/** Jev state + one typed yes/no per candidate. */
export function buildGateRequest(intent: string, cands: HookCandidate[]) {
  const state = {
    agent_is_looking_for: intent.slice(0, 1500),
    candidates: Object.fromEntries(
      cands.map((c) => [c.id, `${c.path}${c.l0 ? `:${c.l0}-${c.l1 ?? c.l0}` : ""} ${c.symbol ?? ""}\n${(c.snippet ?? "").slice(0, 600)}`]),
    ),
  };
  const questions = Object.fromEntries(
    cands.map((c) => [
      c.id,
      {
        type: "noul" as const,
        instructions: `Is candidate ${c.id} code the agent needs to read or edit for what it is looking for (not a test, doc, or code that only mentions the same words)?`,
      },
    ]),
  );
  return { state, questions };
}

/** Apply Jev probabilities: keep p >= threshold, best first, at most HOOK_MAX_SHOWN. Null probs (Jev down) -> show nothing. */
export function gateCandidates(
  cands: HookCandidate[],
  probs: Record<string, number> | null,
  threshold = HOOK_GATE_THRESHOLD,
): HookCandidate[] {
  if (!probs) return [];
  return cands
    .map((c) => ({ ...c, p: probs[c.id] ?? 0 }))
    .filter((c) => (c.p ?? 0) >= threshold)
    .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
    .slice(0, HOOK_MAX_SHOWN);
}

/** The block appended after grep output ('' when nothing passes the gate). */
export function formatPointerBlock(shown: HookCandidate[], grepHits: string[]): string {
  if (shown.length === 0) return "";
  const lines = ["", "--- papr: code this search may have missed (hints; verify before editing) ---"];
  for (const c of shown) {
    const loc = c.l0 ? `:${c.l0}-${c.l1 ?? c.l0}` : "";
    lines.push(`${c.path}${loc}${c.symbol ? `  ${c.symbol}` : ""}  (${c.why})`);
  }
  const testDocs = grepHits.filter((h) => TEST_OR_DOC.test(h)).length;
  if (grepHits.length && testDocs * 2 >= grepHits.length) {
    lines.push(`note: ${testDocs} of ${grepHits.length} files in the grep output are tests or docs`);
  }
  return `${lines.join("\n")}\n`;
}
