/**
 * Lint mini-apps for excessive raw SQL calls AND missing backend handlers.
 *
 * When a frontend has many /api/db/query and /api/db/write calls but no
 * backend/ directory, it's a strong signal the agent skipped the backend
 * layer — the #1 mini-app architecture anti-pattern ("frontend SQL soup").
 *
 * Also detects external API calls with headers that suggest secret keys
 * (Authorization, x-api-key) — those MUST go through backend handlers,
 * never from the browser.
 *
 * Severity escalates:
 *   - 5–8 raw DB calls → warning (nudge)
 *   - 9+ raw DB calls → error (you definitely need backend handlers)
 *   - Any external API call with auth headers → error (secrets in browser)
 */

import type { ValidationIssue } from "../services/AppService.js";
import { BACKEND_FOLDER } from "./appBackendScaffold.js";

/** Matches fetch('/api/db/query' or fetch('/api/db/write' or fetch(`/api/db/query` etc. */
const DB_CALL_PATTERN =
  /fetch\s*\(\s*['"`]\/api\/db\/(query|write|exec)['"`]/g;

/**
 * Matches external API calls with auth-like headers from frontend code.
 * Detects patterns like:
 *   'Authorization': 'Bearer ...'
 *   'x-api-key': ...
 *   headers: { Authorization: ... }
 */
const EXTERNAL_API_AUTH_PATTERN =
  /['"`](Authorization|x-api-key|api-key|apikey)['"`]\s*:/gi;

/**
 * Matches fetch() calls to external URLs (not /api/ local endpoints).
 * Catches: fetch('https://api.example.com/...') or fetch(`https://...`)
 */
const EXTERNAL_FETCH_PATTERN =
  /fetch\s*\(\s*['"`]https?:\/\//g;

/** Threshold: more than this many raw DB calls without a backend/ → warning. */
const SUGGEST_BACKEND_THRESHOLD = 4;

/** Above this threshold, escalate from warning to error. */
const REQUIRE_BACKEND_THRESHOLD = 8;

function isFrontendSource(relativePath: string): boolean {
  if (
    relativePath.startsWith(`${BACKEND_FOLDER}/`) ||
    relativePath.startsWith(`${BACKEND_FOLDER}\\`)
  ) {
    return false;
  }
  return /\.(ts|tsx|js|jsx)$/.test(relativePath);
}

export function checkFrontendSqlOveruse(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  // Check if backend/ exists — if it does, the agent at least tried
  const hasBackend = [...fileContents.keys()].some(
    (f) =>
      f.startsWith(`${BACKEND_FOLDER}/`) ||
      f.startsWith(`${BACKEND_FOLDER}\\`),
  );

  const issues: ValidationIssue[] = [];

  // Count raw DB calls across all frontend files
  let totalDbCalls = 0;
  const filesWithDbCalls: string[] = [];

  // Track external API calls with auth headers
  const filesWithExternalAuth: string[] = [];

  for (const [filename, content] of fileContents.entries()) {
    if (!isFrontendSource(filename)) {
      continue;
    }

    // Check raw DB calls
    const dbMatches = content.match(DB_CALL_PATTERN);
    if (dbMatches && dbMatches.length > 0) {
      totalDbCalls += dbMatches.length;
      filesWithDbCalls.push(filename);
    }

    // Check external API calls with auth headers (secrets in browser)
    const hasExternalFetch = EXTERNAL_FETCH_PATTERN.test(content);
    EXTERNAL_FETCH_PATTERN.lastIndex = 0; // reset regex state
    const hasAuthHeader = EXTERNAL_API_AUTH_PATTERN.test(content);
    EXTERNAL_API_AUTH_PATTERN.lastIndex = 0; // reset regex state

    if (hasExternalFetch && hasAuthHeader && !hasBackend) {
      filesWithExternalAuth.push(filename);
    }
  }

  // External API calls with auth headers from frontend — always an error
  if (filesWithExternalAuth.length > 0) {
    const fileList = filesWithExternalAuth.join(", ");
    issues.push({
      file: filesWithExternalAuth[0] ?? "app",
      severity: "error" as const,
      message:
        `Frontend files (${fileList}) make external API calls with auth headers (Authorization, x-api-key) ` +
        `but no backend/ directory exists. API keys and secrets MUST stay server-side — ` +
        `move these calls to backend handlers (apps/{appId}/backend/ + manifest.json) ` +
        `with vault keys declared in the manifest. Never expose API keys in browser code.`,
      rule: "frontend-api-secrets",
    });
  }

  // Skip DB call check if backend exists
  if (hasBackend) {
    return issues;
  }

  if (totalDbCalls <= SUGGEST_BACKEND_THRESHOLD) {
    return issues;
  }

  const fileList = filesWithDbCalls.join(", ");

  // Escalate severity based on count
  const severity = totalDbCalls > REQUIRE_BACKEND_THRESHOLD ? "error" : "warning";
  const urgency = severity === "error"
    ? `App has ${totalDbCalls} raw /api/db/* calls — this is frontend SQL soup. `
    : `App has ${totalDbCalls} raw /api/db/* calls across frontend files (${fileList}) `;

  issues.push({
    file: filesWithDbCalls[0] ?? "app",
    severity: severity as "error" | "warning",
    message:
      urgency +
      `but no backend/ directory. Extract DB operations into backend handlers ` +
      `(apps/{appId}/backend/ + manifest.json) — backend handlers aren't just for SQL: ` +
      `use them for external API calls, vault secrets, server-side validation, ` +
      `file operations, and multi-table transactions. ` +
      `See EXAMPLE_APP_ARCHITECTURE_PLAN.md "Anti-pattern: Frontend SQL soup".`,
    rule: "suggest-backend-handlers",
  });

  return issues;
}
