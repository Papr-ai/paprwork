/**
 * Lint: private tables (declared in the database registry, `privateTables`).
 *
 * Browser SQL on the cloud host runs with a Turso token that excludes private
 * tables (for everyone, owner included), so:
 *   - frontend code that queries a private table breaks on the web  → ERROR
 *   - a backend action that reads a private table without an `_acl`
 *     filter returns every user's rows                              → ERROR
 *     (opt out per handler with the marker `# acl: all-rows` / `// acl: all-rows`)
 *
 * Errors block publish (see cloud publish preflight). Each issue carries the
 * table name so the UI / agent can explain exactly what to move.
 */

import type { ValidationIssue } from "../services/AppService.js";

export const TABLE_ACL_FRONTEND_RULE = "table-acl-frontend";
export const TABLE_ACL_UNFILTERED_RULE = "table-acl-unfiltered";

const ACL_SCOPED_RE =
  /acl_read_filter\s*\(|acl_write_filter\s*\(|acl_for_caller\s*\(|\b_acl\b|:caller_id\b/;
const ALL_ROWS_MARKER_RE = /(?:#|\/\/)\s*acl:\s*all-rows\b/i;

export interface TableAclIssue extends ValidationIssue {
  table: string;
}

function mentions(content: string, table: string): number[] {
  const esc = table.replace(/[$]/g, "\\$");
  const re = new RegExp(
    `\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+(?:main\\.)?["'\`[]?${esc}\\b`,
    "gi",
  );
  const lines: number[] = [];
  for (const m of content.matchAll(re)) {
    lines.push(content.slice(0, m.index ?? 0).split("\n").length);
  }
  return lines;
}

function isBackendFile(file: string): boolean {
  return /^backend[\\/].+\.(py|ts|js)$/.test(file);
}

function isFrontendFile(file: string): boolean {
  if (isBackendFile(file)) return false;
  if (/^(dist|node_modules|__papr__|databases|migrations)[\\/]/.test(file)) return false;
  return /\.(ts|tsx|js|jsx|html)$/.test(file);
}

export function checkMiniAppTableAcl(
  files: Map<string, string>,
  privateTables: ReadonlySet<string>,
): TableAclIssue[] {
  if (privateTables.size === 0) return [];
  const issues: TableAclIssue[] = [];
  for (const [file, content] of files) {
    const backend = isBackendFile(file);
    const frontend = isFrontendFile(file);
    if (!backend && !frontend) continue;
    for (const table of privateTables) {
      const lines = mentions(content, table);
      if (lines.length === 0) continue;
      if (frontend) {
        for (const line of lines) {
          issues.push({
            file,
            line,
            table,
            severity: "error",
            rule: TABLE_ACL_FRONTEND_RULE,
            message:
              `"${table}" is private, so the browser can't query it on the web. ` +
              "Move this read/write into a backend action and call it with papr.backend.run().",
          });
        }
      }
      if (backend && !ACL_SCOPED_RE.test(content) && !ALL_ROWS_MARKER_RE.test(content)) {
        issues.push({
          file,
          line: lines[0],
          table,
          severity: "error",
          rule: TABLE_ACL_UNFILTERED_RULE,
          message:
            `Backend action reads private table "${table}" without a row filter, so every ` +
            "signed-in user would see every row. Filter with papr_db.acl_read_filter() " +
            "(acl_write_filter() for UPDATE/DELETE, acl_for_caller() on INSERT), or add " +
            "`# acl: all-rows` if returning all rows is intended.",
        });
      }
    }
  }
  return issues;
}

/** Group issues by table → [file:line] for UI/agent messages. */
export function summarizeTableAclIssues(
  issues: ReadonlyArray<TableAclIssue>,
): Array<{ table: string; rule: string; sites: string[] }> {
  const by = new Map<string, { table: string; rule: string; sites: string[] }>();
  for (const i of issues) {
    const key = `${i.table}|${i.rule}`;
    const entry = by.get(key) ?? { table: i.table, rule: i.rule ?? "", sites: [] };
    entry.sites.push(i.line ? `${i.file}:${i.line}` : i.file);
    by.set(key, entry);
  }
  return [...by.values()];
}
