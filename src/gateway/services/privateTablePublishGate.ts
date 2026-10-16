/**
 * Publish preflight for private tables.
 *
 * Same lint as validate_app (miniAppTableAclLint), run against the app's
 * private tables right before code goes to the web. Any error blocks the
 * publish with a structured error the sync panel + agent tools both read:
 *
 *   { code: "private_table_violation", message, tables: [{ table, rule, sites[] }] }
 *
 * The message is plain English (shown in "Last publish didn't finish");
 * the full detail goes to "Ask agent".
 */

import * as fs from "fs/promises";
import * as path from "path";
import { resolveAppPrivateTables } from "./appPrivateTables.js";
import {
  checkMiniAppTableAcl,
  summarizeTableAclIssues,
  TABLE_ACL_FRONTEND_RULE,
} from "../utils/miniAppTableAclLint.js";

export const PRIVATE_TABLE_VIOLATION = "private_table_violation";

export interface PrivateTableViolation {
  code: typeof PRIVATE_TABLE_VIOLATION;
  message: string;
  tables: Array<{ table: string; rule: string; sites: string[] }>;
}

export class PrivateTablePublishError extends Error {
  readonly code = PRIVATE_TABLE_VIOLATION;
  readonly status = 422;
  constructor(readonly detail: PrivateTableViolation) {
    super(formatViolationForAgent(detail));
    this.name = "PrivateTablePublishError";
  }
}

const SKIP_DIRS = new Set(["node_modules", "dist", "__papr__", "databases", ".git"]);

async function readSources(appDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(appDir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(r);
      } else if (/\.(ts|tsx|js|jsx|html|py)$/.test(e.name)) {
        out.set(r, await fs.readFile(path.join(appDir, r), "utf8").catch(() => ""));
      }
    }
  }
  await walk("");
  return out;
}

/** One short line for the sync panel ("Last publish didn't finish"). */
export function describeViolation(tables: PrivateTableViolation["tables"]): string {
  const names = [...new Set(tables.map((t) => t.table))];
  const list = names.length === 1 ? `"${names[0]}" is` : `${names.map((n) => `"${n}"`).join(", ")} are`;
  return tables.some((t) => t.rule === TABLE_ACL_FRONTEND_RULE)
    ? `${list} private, but the page still reads it directly. Ask the agent to move it to a backend action.`
    : `${list} private, but a backend action returns every row. Ask the agent to add a row filter.`;
}

/** Full text for Ask agent: the short line, then every call site. */
export function formatViolationForAgent(v: PrivateTableViolation): string {
  const lines = v.tables.map((t) => `- ${t.table} (${t.rule}): ${t.sites.join(", ")}`);
  return `${v.message}\nPrivate-table check (${v.code}):\n${lines.join("\n")}`;
}

/** Null when the app is clean (or has no private tables). */
export async function checkPrivateTablesForPublish(
  appDir: string,
): Promise<PrivateTableViolation | null> {
  const { tables } = await resolveAppPrivateTables(appDir);
  if (tables.size === 0) return null;
  const issues = checkMiniAppTableAcl(await readSources(appDir), tables);
  if (issues.length === 0) return null;
  const summary = summarizeTableAclIssues(issues);
  return { code: PRIVATE_TABLE_VIOLATION, message: describeViolation(summary), tables: summary };
}

export async function assertPrivateTablesPublishable(appDir: string): Promise<void> {
  const v = await checkPrivateTablesForPublish(appDir);
  if (v) throw new PrivateTablePublishError(v);
}
