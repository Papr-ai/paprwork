/**
 * Canonical guidance for mini-app job event integration.
 * Shared by validate_app and tool reminders when polling anti-patterns are detected.
 */

import type { ValidationIssue } from "../services/AppService.js";

export const JOB_EVENTS_SDK_IMPORT =
  "Import subscribeJobEvents from '/__papr__/papr-job-events.ts' (runtime SDK served by the gateway). " +
  "See system prompt and read_skill({ skillId: \"preloaded-app-and-jobs-guide\" }).";

export const JOB_EVENTS_CANONICAL_SNIPPET = `import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';

const JOB_ID = 'your-job-id';

// Subscribe once on load — tear down on page unload if needed
const unsub = subscribeJobEvents({
  jobIds: [JOB_ID],
  onDbChanged: () => loadData(),           // PRIMARY when job writes $APP_DB
  onStatusChanged: (e) => updateBadge(e),  // lifecycle badge; parse lastOutput if no DB
});

async function triggerJob() {
  await fetch('/api/jobs/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: JOB_ID }),
  });
  // No poll loop — onDbChanged / onStatusChanged refresh the UI
}`;

export function hasJobEventsPollingIssues(
  issues: ReadonlyArray<Pick<ValidationIssue, "rule">>,
): boolean {
  return issues.some(
    (issue) =>
      issue.rule === "no-db-polling" || issue.rule === "prefer-job-events",
  );
}

export function formatJobEventsFixGuidance(): string {
  return [
    "─── Job events fix (apply this pattern) ───",
    JOB_EVENTS_SDK_IMPORT,
    "",
    "Copy-paste pattern:",
    JOB_EVENTS_CANONICAL_SNIPPET,
    "──────────────────────────────────────────",
  ].join("\n");
}
