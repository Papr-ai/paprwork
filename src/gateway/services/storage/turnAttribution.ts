/**
 * Per-turn attribution: who paid for a turn and what it worked on.
 *
 * Three nullable TEXT columns on `messages`, written next to the turn metrics:
 *   - turn_billing: "api_key" | "subscription" | "papr" — the credential that
 *     served the turn. `cost` is always the API-price value; this says whether
 *     that money actually left an API key or was covered by a plan.
 *   - turn_app_id:  the Papr mini-app the turn touched (or the focused app)
 *   - turn_repo:    the git repo (basename) the turn touched outside Papr
 *
 * Rows written before this shipped read NULL; the Agents overview falls back
 * to inferring app/repo from the stored tool-call args for those.
 */

import type Database from "better-sqlite3";
import { execFileSync } from "child_process";
import * as path from "path";

export type TurnBilling = "api_key" | "subscription" | "papr";

export interface TurnAttribution {
  billing: TurnBilling | null;
  appId: string | null;
  repo: string | null;
}

const ATTRIBUTION_COLUMNS = [
  { name: "turn_billing", sql: "TEXT" },
  { name: "turn_app_id", sql: "TEXT" },
  { name: "turn_repo", sql: "TEXT" },
] as const;

export function migrateTurnAttributionColumns(db: Database.Database): void {
  const columns = db.pragma("table_info(messages)") as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const column of ATTRIBUTION_COLUMNS) {
    if (!names.has(column.name)) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${column.name} ${column.sql}`);
    }
  }
}

export function storeTurnAttribution(
  db: Database.Database,
  messageId: string,
  attribution: TurnAttribution,
): void {
  db.prepare(
    `UPDATE messages SET turn_billing = ?, turn_app_id = ?, turn_repo = ? WHERE id = ?`,
  ).run(attribution.billing, attribution.appId, attribution.repo, messageId);
}

export function billingFor(config: {
  authType?: "oauth" | "apiKey";
  usePaprProxy?: boolean;
}): TurnBilling {
  if (config.usePaprProxy) return "papr";
  return config.authType === "oauth" ? "subscription" : "api_key";
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const APP_PATH_RE = new RegExp(`/apps/(${UUID})`, "gi");
const APP_ARG_RE = new RegExp(`^${UUID}$`, "i");
/** Common checkout roots; anything else is resolved through git when allowed. */
const REPO_PATH_RE = /\/(?:Documents\/GitHub|GitHub|github|repos|Projects|projects|Developer)\/([A-Za-z0-9._-]+)/g;
const ABS_PATH_RE = /(?:^|[\s"'=])((?:~|\/)[^\s"'`;|&<>()]+)/g;

export interface ToolCallLike {
  name?: string;
  toolName?: string;
  args?: Record<string, unknown>;
}

/** Strings worth scanning for paths: path-ish args plus the start of a bash command. */
export function toolCallText(call: ToolCallLike): string {
  const args = call.args ?? {};
  const parts: string[] = [];
  for (const key of ["path", "cwd", "filePath", "file", "directory", "appId", "repoPath"]) {
    const value = args[key];
    if (typeof value === "string") parts.push(value);
  }
  if (typeof args.command === "string") parts.push(args.command.slice(0, 400));
  return parts.join("\n");
}

const gitRootCache = new Map<string, string | null>();

function gitRepoName(dir: string): string | null {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir) ?? null;
  let name: string | null = null;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
    name = root ? path.basename(root) : null;
  } catch {
    name = null;
  }
  gitRootCache.set(dir, name);
  return name;
}

/**
 * Most-mentioned app and repo in a turn's tool calls.
 *
 * `resolveGit` lets the live write path ask git for the repo root of paths
 * outside the common checkout folders; the history scan leaves it off so a
 * 30-day aggregate never shells out thousands of times.
 */
export function inferTurnTargets(
  texts: string[],
  options: { paprRoot?: string; resolveGit?: boolean } = {},
): { appId: string | null; repo: string | null } {
  const apps = new Map<string, number>();
  const repos = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const home = process.env.HOME ?? "";

  for (const text of texts) {
    if (!text) continue;
    if (APP_ARG_RE.test(text.trim())) bump(apps, text.trim().toLowerCase());
    for (const m of text.matchAll(APP_PATH_RE)) bump(apps, m[1].toLowerCase());
    const before = repos.size;
    for (const m of text.matchAll(REPO_PATH_RE)) bump(repos, m[1]);
    if (!options.resolveGit || repos.size > before) continue;
    for (const m of text.matchAll(ABS_PATH_RE)) {
      const abs = m[1].startsWith("~") ? path.join(home, m[1].slice(1)) : m[1];
      if (options.paprRoot && abs.startsWith(options.paprRoot)) continue;
      if (abs.split(path.sep).length < 4) continue;
      const name = gitRepoName(path.extname(abs) ? path.dirname(abs) : abs);
      if (name) bump(repos, name);
    }
  }

  const top = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { appId: top(apps), repo: top(repos) };
}
