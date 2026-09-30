/**
 * Lint mini-apps for load-efficiency patterns: batch reads, debounced SSE refresh.
 */

import type { ValidationIssue } from "../services/AppService.js";
import { BACKEND_FOLDER } from "./appBackendScaffold.js";

const DB_QUERY_FETCH =
  /fetch\s*\(\s*['"`]\/api\/db\/query['"`]/g;
const DB_BATCH_FETCH =
  /fetch\s*\(\s*['"`]\/api\/db\/(?:batch|query-batch|read-batch)['"`]/g;

const DB_QUERY_IN_ARRAY_ITERATION =
  /\.(?:map|forEach|flatMap)\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*\{[\s\S]{0,1200}?fetch\s*\(\s*['"`]\/api\/db\/query['"`]/;

const SYNC_ITEMS_POLL =
  /setInterval\s*\([\s\S]{0,600}?fetch\s*\(\s*['"`]\/api\/sync\/items/;

const SYNC_ITEMS_NO_REFRESH =
  /fetch\s*\(\s*['"`]\/api\/sync\/items(?![^'"`]*refresh=1)[^'"`]*['"`]/;

const LOAD_FUNCTION_HEAD =
  /(?:async\s+)?function\s+(loadData|loadAll|fetchAll|refreshAll|initApp|bootstrap|loadDashboard|loadPage)\s*\([^)]*\)\s*\{/g;

function hasDirectOnDbChangedLoad(content: string): boolean {
  if (!/onDbChanged\s*:/.test(content)) {
    return false;
  }
  const refreshCall =
    /onDbChanged\s*:[\s\S]{0,120}?((?:loadData|loadAll|fetchAll|refreshAll|render)\s*\(|=>\s*\{?\s*(?:void\s+)?(?:loadData|loadAll|fetchAll|refreshAll|render)\s*\()/;
  return refreshCall.test(content);
}

const DEBOUNCE_SIGNALS =
  /debounceMs|debounce\s*\(|debounced|clearTimeout\s*\(|AbortController|inFlight|pendingRefresh|scheduleRefresh|refreshTimer|loadSeq|requestId/i;

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

function countMatches(pattern: RegExp, text: string): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].length;
}

/** Extract function body text starting at opening `{` of a function match. */
function sliceFunctionBody(content: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return content.slice(openBraceIndex, i + 1);
      }
    }
  }
  return content.slice(openBraceIndex);
}

function countDbQueriesInLoadFunctions(content: string): {
  maxInOneFunction: number;
  functionName?: string;
  index?: number;
} {
  let maxInOneFunction = 0;
  let bestName: string | undefined;
  let bestIndex: number | undefined;

  const head = new RegExp(LOAD_FUNCTION_HEAD.source, "g");
  let match: RegExpExecArray | null;
  while ((match = head.exec(content)) !== null) {
    const name = match[1] ?? "load";
    const openBrace = content.indexOf("{", match.index);
    if (openBrace < 0) {
      continue;
    }
    const body = sliceFunctionBody(content, openBrace);
    const count = countMatches(DB_QUERY_FETCH, body);
    if (count > maxInOneFunction) {
      maxInOneFunction = count;
      bestName = name;
      bestIndex = match.index;
    }
  }

  return {
    maxInOneFunction,
    functionName: bestName,
    index: bestIndex,
  };
}

export function checkMiniAppLoadEfficiencyPatterns(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [filename, content] of fileContents.entries()) {
    if (!isFrontendSource(filename)) {
      continue;
    }

    const { maxInOneFunction } = countDbQueriesInLoadFunctions(content);

    if (maxInOneFunction >= 2) {
      const head = new RegExp(LOAD_FUNCTION_HEAD.source, "g");
      let fnMatch: RegExpExecArray | null;
      while ((fnMatch = head.exec(content)) !== null) {
        const name = fnMatch[1] ?? "load";
        const openBrace = content.indexOf("{", fnMatch.index);
        if (openBrace < 0) {
          continue;
        }
        const body = sliceFunctionBody(content, openBrace);
        const queryCount = countMatches(DB_QUERY_FETCH, body);
        const batchInBody = countMatches(DB_BATCH_FETCH, body);
        if (queryCount >= 2 && batchInBody === 0) {
          issues.push({
            file: filename,
            line: lineNumber(content, fnMatch.index),
            severity: "warning",
            message:
              `${name}() issues ${queryCount} separate POST /api/db/query calls — ` +
              "combine reads with POST /api/db/batch (one round-trip). See get_papr_api_reference batch reads.",
            rule: "mount-multi-db-query",
          });
          break;
        }
      }
    }

    if (DB_QUERY_IN_ARRAY_ITERATION.test(content)) {
      const idx = content.search(DB_QUERY_IN_ARRAY_ITERATION);
      issues.push({
        file: filename,
        line: idx >= 0 ? lineNumber(content, idx) : undefined,
        severity: "warning",
        message:
          "POST /api/db/query inside .map/.forEach is an N+1 read pattern — " +
          "fetch rows in one query or POST /api/db/batch with multiple statements.",
        rule: "db-query-in-loop",
      });
    }

    if (SYNC_ITEMS_POLL.test(content) && SYNC_ITEMS_NO_REFRESH.test(content)) {
      const idx = content.search(SYNC_ITEMS_POLL);
      issues.push({
        file: filename,
        line: idx >= 0 ? lineNumber(content, idx) : undefined,
        severity: "warning",
        message:
          "Poll /api/sync/items without ?refresh=1 (cached, no git reconcile). " +
          "Use ?refresh=1 only after user upload/pull/merge or when upload wait finishes.",
        rule: "sync-items-poll-no-refresh",
      });
    }

    if (hasDirectOnDbChangedLoad(content)) {
      const subscribeBlock = content.match(
        /subscribeJobEvents\s*\(\s*\{[\s\S]{0,1600}?\}\s*\)/,
      )?.[0];
      const hasDebounceMs =
        subscribeBlock !== undefined &&
        /debounceMs\s*:\s*\d+/.test(subscribeBlock);
      const hasLocalDebounce =
        subscribeBlock !== undefined && DEBOUNCE_SIGNALS.test(subscribeBlock);

      const totalQueries = countMatches(DB_QUERY_FETCH, content);
      if (
        totalQueries >= 2 &&
        !hasDebounceMs &&
        !hasLocalDebounce
      ) {
        const idx = content.search(/onDbChanged\s*:/);
        issues.push({
          file: filename,
          line: idx >= 0 ? lineNumber(content, idx) : undefined,
          severity: "warning",
          message:
            "onDbChanged calls loadData() directly with no debounce — SSE can burst during job writes. " +
            "Use subscribeJobEvents({ debounceMs: 300, onDbChanged: () => loadData() }) or AbortController in loadData().",
          rule: "on-db-changed-no-debounce",
        });
      }
    }
  }

  return issues;
}
