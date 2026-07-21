/**
 * Canonical mini-app testing decision tree — shared by system prompt,
 * validate_app, and webview tool descriptions so agents pick the right tool.
 */

export const MINI_APP_TESTING_DECISION_TREE = `Mini-app testing — pick the right tool:
| Goal | Tool | NOT this |
|------|------|----------|
| Compile / lint / import errors | validate_app | webview_execute |
| Runtime JS errors (ReferenceError, etc.) | validate_app (auto preview + iframe console) OR webview_get_console | webview_execute |
| Visual layout / blank UI / overlays | webview_snapshot (check visualState) | webview_execute |
| API endpoint works | bash + curl http://localhost:18789/api/... | webview_execute |
| DB row inserted/updated | bash + curl /api/db/query | webview_execute |
| Job output / lastOutput | run_job + read_job_logs OR curl /api/jobs/status | webview_execute |
| Multi-step UI flow (click → fill → save) | Fix source + curl DB to verify | webview_execute (too fragile) |

validate_app automatically launches a preview and fails on console errors. Iframe errors while the user tests are forwarded to GET /api/apps/{appId}/runtime-logs.
Preview workflow after edits (optional visual): webview_launch_app → page_wait_for({ target: 'mini_app', time: 2 }) → webview_snapshot.
webview_execute is ONLY for one-shot DOM reads (element count, window.__paprBoot, getElementById text). Scripts must return a value or result is undefined.`;

export function formatMiniAppTestingGuide(): string {
  return MINI_APP_TESTING_DECISION_TREE;
}
