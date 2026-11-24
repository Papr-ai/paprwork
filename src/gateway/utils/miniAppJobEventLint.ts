/**
 * Lint mini-apps for polling anti-patterns that cause expensive cloud DB reads
 * and retry floods on the shared app host (#957).
 *
 * Checks are per call site, across all files, and apply whether or not the file
 * imports the job-events SDK: an app can subscribe to onDbChanged and still poll
 * a backend action on a timer (that is exactly how #957 slipped through).
 *
 * A "poller" is any function whose body hits /api/db/query|batch,
 * /api/app/backend/ or /api/jobs/status, directly or via another poller
 * (resolved across files, so `setInterval(refresh)` where refresh → api() → fetch
 * is caught).
 */

import type { ValidationIssue } from "../services/AppService.js";

/** Runtime import — declare function does NOT count (erased at compile, ReferenceError at runtime). */
function hasJobEventsSdkImport(content: string): boolean {
  return /import\s*\{[^}]*\b(?:subscribeJobEvents|runJobAndWaitForComplete)\b[^}]*\}\s*from\s*['"`][^'"`]*papr-job-events/.test(
    content,
  );
}

const POLL_HIT = /\/api\/(?:db\/(?:query|batch)|app\/backend\/|jobs\/status)/;
const DB_HIT = /\/api\/db\/(?:query|batch)/;
const AWAIT_SLEEP = /await\s+new\s+Promise\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*(?:window\.)?setTimeout/;
/** Retries faster than this (ms) after an error count as a flood. */
const MIN_RETRY_MS = 5000;

/** Blank out comments (keeping newlines) so commented-out code doesn't count and line numbers stay right. */
function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])(\/\/[^\n]*)/gm, (_m, pre: string, c: string) => pre + blank(c));
}

/** Text between the bracket at `open` and its match (exclusive). Approximate: ignores brackets in strings. */
function span(src: string, open: number): string {
  const o = src[open];
  const c = o === "(" ? ")" : o === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** Blank the inside of '..' and ".." strings so names inside messages ("Could not save") don't count as calls. */
function stripStrings(src: string): string {
  return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

const esc = (s: string) => s.replace(/[$]/g, "\\$&");
const refers = (text: string, name: string) => new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])`).test(stripStrings(text));

/** Spans of user-event handlers (addEventListener / onX =): a one-shot re-render after a click is not polling. */
function eventRegions(body: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of body.matchAll(/\.addEventListener\s*\(|\.on[a-z]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    out.push([open, open + span(body, open).length + 1]);
  }
  return out;
}
const inside = (rs: [number, number][], i: number) => rs.some(([a, b]) => i > a && i < b);

type Fn = { name: string; body: string; file: string; start: number };

/** Named functions and arrow functions assigned to a const/let/var, with their bodies. */
function functions(file: string, src: string): Fn[] {
  const out: Fn[] = [];
  const decl = /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{1,80})?=\s*(?:async\s*)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]{1,80})?=>\s*/g;
  for (const m of src.matchAll(decl)) {
    const b = src.indexOf("{", m.index! + m[0].length + span(src, m.index! + m[0].length - 1).length);
    if (b > 0) out.push({ name: m[1], body: span(src, b), file, start: b });
  }
  for (const m of src.matchAll(arrow)) {
    const at = m.index! + m[0].length;
    const body = src[at] === "{" ? span(src, at) : src.slice(at, at + 400).split(/;|\n\s*\n/)[0];
    out.push({ name: m[1], body, file, start: at });
  }
  return out;
}

/** Names of functions that (transitively) hit a polling endpoint. */
function pollers(fns: Fn[]): Set<string> {
  const set = new Set(fns.filter((f) => POLL_HIT.test(f.body)).map((f) => f.name));
  for (let round = 0; round < 6; round++) {
    const before = set.size;
    for (const f of fns) if (!set.has(f.name) && [...set].some((n) => refers(f.body, n))) set.add(f.name);
    if (set.size === before) break;
  }
  return set;
}

function callsPoller(text: string, ps: Set<string>): boolean {
  return POLL_HIT.test(text) || [...ps].some((n) => refers(text, n));
}

/** Last argument of a setTimeout/setInterval call as a number of ms, when it is a literal. */
function delayMs(args: string): number | undefined {
  const m = /,\s*([0-9][0-9_]*)\s*$/.exec(args.trim());
  return m ? Number(m[1].replace(/_/g, "")) : undefined;
}

const FIX =
  "Refresh on events instead: subscribeJobEvents({ onDbChanged }) for job writes, re-load after the user's own action, " +
  "or on visibilitychange/focus. Import from '/__papr__/papr-job-events.ts'.";

export function checkMiniAppJobEventPatterns(fileContents: Map<string, string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const files = Array.from(fileContents.entries())
    .filter(([name]) => /\.(ts|tsx|js|jsx)$/.test(name) && !/(^|\/)dist\//.test(name))
    .map(([name, raw]) => [name, stripComments(raw), raw] as const);

  for (const [filename, , raw] of files) {
    if (/from\s*['"`]\.\/?(?:papr-)?job-events(?:\.ts)?['"`]/.test(raw) || /(?:papr-)?job-events\.ts$/.test(filename)) {
      issues.push({
        file: filename, line: 1, severity: "error", rule: "no-job-events-shim",
        message:
          "Do not copy or shim papr-job-events locally. Import from '/__papr__/papr-job-events.ts' — " +
          "the bundler leaves it external and the gateway/cloud host serves it at runtime.",
      });
    }
    if (/\bsubscribeJobEvents\s*\(/.test(raw) && !hasJobEventsSdkImport(raw)) {
      const declareOnly = /\bdeclare\s+function\s+subscribeJobEvents\b/.test(raw);
      issues.push({
        file: filename, line: lineOf(raw, raw.search(/\bsubscribeJobEvents\s*\(/)), severity: "error",
        rule: "missing-job-events-import",
        message: declareOnly
          ? 'subscribeJobEvents is declared but never imported — "declare function" is compile-time only and causes ReferenceError at runtime. ' +
            "Replace with: import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';"
          : "subscribeJobEvents() is called without importing the SDK — causes ReferenceError at runtime. " +
            "Add: import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';",
      });
    }
  }

  const fns = files.flatMap(([name, src]) => functions(name, src));
  const ps = pollers(fns);
  const seen = new Set<string>();
  const add = (file: string, line: number, message: string) => {
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ file, line, severity: "error", rule: "no-db-polling", message });
  };

  for (const [filename, src] of files) {
    // 1. setInterval whose callback reaches a polling endpoint.
    for (const m of src.matchAll(/\bsetInterval\s*\(/g)) {
      const args = span(src, m.index! + m[0].length - 1);
      if (!callsPoller(args, ps)) continue;
      const ms = delayMs(args);
      const fast = DB_HIT.test(args) && ms !== undefined && ms < 5000 ? ` Interval ${ms}ms on /api/db is far too aggressive (cloud bills per row read).` : "";
      add(filename, lineOf(src, m.index!), `Polling: setInterval calls an API endpoint on a timer.${fast} ${FIX}`);
    }
    // 2. for/while loops that sleep and call an endpoint.
    for (const m of src.matchAll(/\b(?:while|for)\s*\(/g)) {
      const head = m.index! + m[0].length - 1;
      const after = head + span(src, head).length + 2;
      const b = src.slice(after).search(/\S/) + after;
      if (src[b] !== "{") continue;
      const body = span(src, b);
      if (AWAIT_SLEEP.test(body) && callsPoller(body, ps)) {
        add(filename, lineOf(src, m.index!), `Polling: a loop sleeps and re-calls an API endpoint. ${FIX}`);
      }
    }
  }

  // 3. Self-rescheduling pollers (function F → setTimeout(F)) and retry-on-error without backoff.
  for (const f of fns) {
    if (!ps.has(f.name)) continue;
    const src = files.find(([n]) => n === f.file)![1];
    const events = eventRegions(f.body);
    for (const m of f.body.matchAll(/\bsetTimeout\s*\(/g)) {
      if (inside(events, m.index!)) continue;
      const args = span(f.body, m.index! + m[0].length - 1);
      if (!refers(args, f.name)) continue;
      const inCatch = isInsideCatch(f.body, m.index!);
      const ms = delayMs(args);
      if (inCatch && ms !== undefined && ms >= MIN_RETRY_MS) continue; // bounded backoff on failure is fine
      if (inCatch && ms === undefined) continue; // computed delay (backoff) — trust it
      add(f.file, lineOf(src, f.start + m.index!), inCatch
        ? `Retry flood: ${f.name}() retries itself ${ms ?? 0}ms after an error. Back off (≥${MIN_RETRY_MS}ms, growing) and cap attempts.`
        : `Polling: ${f.name}() reschedules itself with setTimeout. ${FIX}`);
    }
    for (const c of catchRegions(f.body)) {
      if (inside(events, c.at)) continue;
      const direct = c.text.replace(/\bsetTimeout\s*\([\s\S]*$/, "");
      if (refers(direct, f.name) && new RegExp(`(?<![\\w$.])${esc(f.name)}\\s*\\(`).test(direct)) {
        add(f.file, lineOf(src, f.start + c.at), `Retry flood: ${f.name}() calls itself again from its own error handler with no delay. Back off (≥${MIN_RETRY_MS}ms, growing) and cap attempts.`);
      }
    }
  }

  // 4. App-level: runs jobs, polls, never subscribes.
  const subscribes = files.some(([, , raw]) => hasJobEventsSdkImport(raw));
  const runsJobs = files.some(([, src]) => /\/api\/jobs\/run/.test(src));
  if (runsJobs && !subscribes && issues.some((i) => i.rule === "no-db-polling")) {
    issues.push({
      file: "app", severity: "error", rule: "prefer-job-events",
      message:
        "App runs jobs (/api/jobs/run) and polls for results without subscribeJobEvents(). " +
        "Import papr-job-events.ts and use onDbChanged (DB writes) or onStatusChanged (lastOutput).",
    });
  }
  return issues;
}

function catchRegions(body: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const m of body.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) out.push({ at: m.index!, text: span(body, m.index! + m[0].length - 1) });
  for (const m of body.matchAll(/\.catch\s*\(/g)) out.push({ at: m.index!, text: span(body, m.index! + m[0].length - 1) });
  return out;
}

function isInsideCatch(body: string, index: number): boolean {
  return catchRegions(body).some((c) => {
    const open = body.indexOf(c.text, c.at);
    return index >= open && index < open + c.text.length;
  });
}

/** Publish gate: polling/retry-flood errors block publishing (validate_app alone is advisory, #957). */
export class MiniAppPollingPublishError extends Error {
  constructor(readonly appId: string, readonly issues: ValidationIssue[]) {
    const first = issues.slice(0, 3).map((i) => `${i.file}${i.line ? `:${i.line}` : ""} ${i.message}`).join("; ");
    super(`Publish blocked for app ${appId}: it polls the server on a timer or retries without backoff. Fix and publish again: ${first}`);
    this.name = "MiniAppPollingPublishError";
  }
}

export async function lintAppDirForPolling(appDir: string): Promise<ValidationIssue[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const files = new Map<string, string>();
  const skip = new Set(["node_modules", "dist", "__papr__", "data", "backend", "content", ".git"]);
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !/\.test\./.test(e.name)) files.set(path.relative(appDir, p), await fs.readFile(p, "utf8"));
    }
  };
  await walk(appDir);
  return checkMiniAppJobEventPatterns(files).filter((i) => i.severity === "error" && i.rule === "no-db-polling");
}
