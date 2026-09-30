/**
 * Lint mini-apps for cloud Turso read-cost anti-patterns.
 *
 * Cloud apps on apps.papr.ai bill per row read. These checks catch query and
 * navigation patterns that cause full-table scans or re-fetch storms — not
 * just setInterval polling (see miniAppJobEventLint.ts).
 */

import type { ValidationIssue } from "../services/AppService.js";
import { BACKEND_FOLDER } from "./appBackendScaffold.js";

function isFrontendSource(relativePath: string): boolean {
  if (
    relativePath.startsWith(`${BACKEND_FOLDER}/`) ||
    relativePath.startsWith(`${BACKEND_FOLDER}\\`)
  ) {
    return false;
  }
  return /\.(ts|tsx|js|jsx)$/.test(relativePath);
}

function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Count (SELECT COUNT(*) occurrences in a SQL string. */
function countSubqueryCounts(sql: string): number {
  const matches = sql.match(/\(SELECT\s+COUNT\s*\(\s*\*\s*\)/gi);
  return matches?.length ?? 0;
}

/** Extract SQL template literals and string literals passed to db helpers. */
function extractSqlLiterals(content: string): Array<{ sql: string; index: number }> {
  const results: Array<{ sql: string; index: number }> = [];

  const templatePattern = /`([^`]*(?:SELECT|INSERT|UPDATE|DELETE|COUNT)[^`]*)`/gi;
  let match: RegExpExecArray | null;
  while ((match = templatePattern.exec(content)) !== null) {
    results.push({ sql: match[1] ?? "", index: match.index });
  }

  const stringPattern = /['"]([^'"]*(?:SELECT|INSERT|UPDATE|DELETE|COUNT)[^'"]*)['"]/gi;
  while ((match = stringPattern.exec(content)) !== null) {
    results.push({ sql: match[1] ?? "", index: match.index });
  }

  return results;
}

function isSelectStarWithoutLimit(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (!/\bSELECT\s+\*\s+FROM\b/i.test(normalized)) {
    return false;
  }
  if (/\bLIMIT\s+\d+/i.test(normalized)) {
    return false;
  }
  // Single-row lookups are OK
  if (/\bWHERE\s+[^;]+\s*=\s*\?/i.test(normalized)) {
    return false;
  }
  return true;
}

function isRuntimeAggregateScan(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, " ").trim();
  const hasCount = /\bCOUNT\s*\(\s*\*\s*\)/i.test(normalized);
  if (!hasCount) {
    return false;
  }
  // Precomputed stats row reads are fine
  if (/\bFROM\s+app_(stats|metadata|summary)\b/i.test(normalized)) {
    return false;
  }
  // Multiple table scans in one query (dashboard soup)
  if (countSubqueryCounts(normalized) >= 2) {
    return true;
  }
  // Full-table COUNT without GROUP BY / WHERE filter
  if (
    /\bSELECT\b[\s\S]*\bCOUNT\s*\(\s*\*\s*\)[\s\S]*\bFROM\b/i.test(normalized) &&
    !/\bWHERE\b/i.test(normalized) &&
    !/\bGROUP\s+BY\b/i.test(normalized) &&
    countSubqueryCounts(normalized) === 0
  ) {
    return true;
  }
  return false;
}

/** Detect tab/view navigation that re-fetches all DB data without caching. */
function detectTabRefetchStorm(content: string, filename: string): boolean {
  const hasMultipleDbCalls =
    (content.match(/fetch\s*\(\s*['"`]\/api\/db\/(query|write|exec)['"`]/g)?.length ??
      0) >= 3;

  if (!hasMultipleDbCalls) {
    return false;
  }

  const hasCache =
    /sessionStorage|localStorage|cache|cachedAt|lastFetch|dataCache|Map\s*</i.test(
      content,
    );
  if (hasCache) {
    return false;
  }

  const navigationTriggers =
    /(?:function\s+(?:render|showTab|switchTab|onTabChange|loadView|navigate)|(?:render|showTab|switchTab)\s*\(|addEventListener\s*\(\s*['"]click['"])/i.test(
      content,
    );
  const refetchOnNav =
    /(?:render|showTab|switchTab|loadView|navigate)[\s\S]{0,800}(?:loadData|fetchAll|loadAll|refreshAll|render\s*\(\s*\))/i.test(
      content,
    );

  return navigationTriggers && refetchOnNav && !filename.includes("backend");
}

export function checkMiniAppCloudReadPatterns(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [filename, content] of fileContents.entries()) {
    if (!isFrontendSource(filename)) {
      continue;
    }

    for (const { sql, index } of extractSqlLiterals(content)) {
      if (countSubqueryCounts(sql) >= 2) {
        issues.push({
          file: filename,
          line: lineNumber(content, index),
          severity: "error",
          message:
            "SQL uses multiple nested COUNT(*) subqueries — each subquery scans an entire table on every page load (Turso bills per row read). " +
            "Fix: add an aggregate table (e.g. app_stats, daily_summary) that a job updates after ETL, then read one row from the app: " +
            "SELECT metrics FROM app_stats WHERE id = 'dashboard'. For ad-hoc aggregates, use a backend handler with caching — not frontend SQL.",
          rule: "cloud-nested-count-subqueries",
        });
      } else if (isRuntimeAggregateScan(sql)) {
        issues.push({
          file: filename,
          line: lineNumber(content, index),
          severity: "warning",
          message:
            "SQL runs COUNT(*) across a table without filters — expensive on cloud Turso at scale. " +
            "Use a precomputed stats row (job writes app_stats after ETL) or a backend handler with caching.",
          rule: "cloud-aggregate-table-scan",
        });
      }

      if (isSelectStarWithoutLimit(sql)) {
        issues.push({
          file: filename,
          line: lineNumber(content, index),
          severity: "warning",
          message:
            "SELECT * without LIMIT — cloud caps at 5,000 rows/query but still bills for every row read. " +
            "Add LIMIT/OFFSET pagination or filter by indexed column.",
          rule: "cloud-select-star-no-limit",
        });
      }
    }

    if (detectTabRefetchStorm(content, filename)) {
      issues.push({
        file: filename,
        severity: "warning",
        message:
          "Tab or view navigation appears to re-fetch all DB data on every switch with no client cache. " +
          "Load data once, cache in memory, refresh only via onDbChanged — not on every tab click.",
        rule: "cloud-tab-refetch-storm",
      });
    }
  }

  return issues;
}
