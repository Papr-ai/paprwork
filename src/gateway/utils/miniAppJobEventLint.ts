/**
 * Lint mini-apps for polling anti-patterns that cause expensive cloud DB reads.
 */

import type { ValidationIssue } from "../services/AppService.js";

/** Runtime import — declare function does NOT count (erased at compile, ReferenceError at runtime). */
function hasJobEventsSdkImport(content: string): boolean {
  return (
    /import\s*\{[^}]*\bsubscribeJobEvents\b[^}]*\}\s*from\s*['"`][^'"`]*papr-job-events/.test(
      content,
    ) ||
    /import\s*\{[^}]*\brunJobAndWaitForComplete\b[^}]*\}\s*from\s*['"`][^'"`]*papr-job-events/.test(
      content,
    )
  );
}

function callsSubscribeJobEvents(content: string): boolean {
  return /\bsubscribeJobEvents\s*\(/.test(content);
}

function usesJobEvents(content: string): boolean {
  return hasJobEventsSdkImport(content);
}

const SET_INTERVAL = /setInterval\s*\(/;

const POLLING_ENDPOINT =
  /\/api\/(?:db\/query|jobs\/status|app\/backend\/)/;

const DB_QUERY_POLL =
  /fetch\s*\(\s*['"`]\/api\/db\/query|['"`]\/api\/db\/query['"`]/;

const JOB_STATUS_POLL =
  /fetch\s*\(\s*[`'"]\/api\/jobs\/status|setInterval[\s\S]{0,400}\/api\/jobs\/status/;

const BACKEND_ACTION_POLL =
  /fetch\s*\(\s*[`'"]\/api\/app\/backend\//;

const AWAIT_SLEEP_LOOP =
  /await\s+new\s+Promise\s*\(\s*(?:resolve|res)\s*=>\s*setTimeout/;

const FOR_LOOP = /\bfor\s*\(/;

const WHILE_LOOP = /\bwhile\s*\(/;

const FAST_INTERVAL_MS = /setInterval\s*\([^,]+,\s*([0-9]+)/g;

function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function hasRepeatedFetchPolling(content: string): boolean {
  if (!POLLING_ENDPOINT.test(content)) {
    return false;
  }

  if (SET_INTERVAL.test(content)) {
    return true;
  }

  const hasSleep = AWAIT_SLEEP_LOOP.test(content);
  const hasLoop = FOR_LOOP.test(content) || WHILE_LOOP.test(content);
  return hasSleep && hasLoop;
}

function pollsEndpoint(content: string): boolean {
  return (
    DB_QUERY_POLL.test(content) ||
    JOB_STATUS_POLL.test(content) ||
    BACKEND_ACTION_POLL.test(content)
  );
}

export function checkMiniAppJobEventPatterns(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allJsTs = Array.from(fileContents.entries()).filter(([name]) =>
    /\.(ts|tsx|js|jsx)$/.test(name),
  );

  const usesJobEventsAnywhere = allJsTs.some(([, content]) =>
    usesJobEvents(content),
  );

  const runsJobsAnywhere = allJsTs.some(([, content]) =>
    /\/api\/jobs\/run/.test(content),
  );

  for (const [filename, content] of allJsTs) {
    if (
      /from\s*['"`]\.\/?(?:papr-)?job-events(?:\.ts)?['"`]/.test(content) ||
      (filename.endsWith("papr-job-events.ts") || filename.endsWith("job-events.ts"))
    ) {
      issues.push({
        file: filename,
        line: 1,
        severity: "error",
        message:
          "Do not copy or shim papr-job-events locally. Import from '/__papr__/papr-job-events.ts' — " +
          "the bundler leaves it external and the gateway/cloud host serves it at runtime.",
        rule: "no-job-events-shim",
      });
    }

    if (callsSubscribeJobEvents(content) && !hasJobEventsSdkImport(content)) {
      const declareOnly = /\bdeclare\s+function\s+subscribeJobEvents\b/.test(
        content,
      );
      issues.push({
        file: filename,
        line: lineNumber(
          content,
          content.search(/\bsubscribeJobEvents\s*\(/),
        ),
        severity: "error",
        message: declareOnly
          ? 'subscribeJobEvents is declared but never imported — "declare function" is compile-time only and causes ReferenceError at runtime. ' +
            "Replace with: import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';"
          : "subscribeJobEvents() is called without importing the SDK — causes ReferenceError at runtime. " +
            "Add: import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';",
        rule: "missing-job-events-import",
      });
    }

    if (usesJobEvents(content)) {
      continue;
    }

    const repeatedPolling = hasRepeatedFetchPolling(content);
    const endpointPolling = pollsEndpoint(content);

    if (repeatedPolling && endpointPolling) {
      const intervalMatch = FAST_INTERVAL_MS.exec(content);
      FAST_INTERVAL_MS.lastIndex = 0;
      const intervalMs = intervalMatch
        ? Number.parseInt(intervalMatch[1], 10)
        : undefined;
      const line = intervalMatch
        ? lineNumber(content, intervalMatch.index)
        : lineNumber(content, content.search(POLLING_ENDPOINT));

      issues.push({
        file: filename,
        line,
        severity: "error",
        message:
          "Polling detected. Use subscribeJobEvents() — apply the snippet from validate_app / system prompt. " +
          "Job writes $APP_DB → onDbChanged: () => loadData(). Job returns lastOutput only → onStatusChanged. " +
          "Import from '/__papr__/papr-job-events.ts'.",
        rule: "no-db-polling",
      });

      if (DB_QUERY_POLL.test(content) && intervalMs !== undefined && intervalMs < 5000) {
        issues.push({
          file: filename,
          line,
          severity: "error",
          message:
            `DB query poll interval ${intervalMs}ms is too aggressive. ` +
            "Use subscribeJobEvents({ onDbChanged }) — cloud Turso bills per row read.",
          rule: "no-db-polling",
        });
      }
      continue;
    }

    if (SET_INTERVAL.test(content) && (endpointPolling || DB_QUERY_POLL.test(content))) {
      issues.push({
        file: filename,
        line: lineNumber(content, content.search(SET_INTERVAL)),
        severity: "error",
        message:
          "setInterval + API polling detected. Use subscribeJobEvents() with onDbChanged or onStatusChanged.",
        rule: "no-db-polling",
      });
    }
  }

  if (runsJobsAnywhere && !usesJobEventsAnywhere) {
    const hasPolling = allJsTs.some(
      ([, content]) =>
        !usesJobEvents(content) &&
        (hasRepeatedFetchPolling(content) ||
          (SET_INTERVAL.test(content) && pollsEndpoint(content))),
    );

    if (hasPolling) {
      issues.push({
        file: "app",
        severity: "error",
        message:
          "App runs jobs (/api/jobs/run) and polls for status without subscribeJobEvents(). " +
          "Import papr-job-events.ts and use onDbChanged (DB writes) or onStatusChanged (lastOutput).",
        rule: "prefer-job-events",
      });
    } else if (allJsTs.some(([, c]) => SET_INTERVAL.test(c) && /\/api\/jobs\/run/.test(c))) {
      issues.push({
        file: "app",
        severity: "error",
        message:
          "App runs jobs and uses setInterval but does not import papr-job-events.ts. " +
          "Use subscribeJobEvents() to react to job completion/progress instead of polling.",
        rule: "prefer-job-events",
      });
    }
  }

  return issues;
}
