# PR 1 · Claude cards: card kit, MCP transport, cards on publish

How a Papr app shows up inside Claude as cards, without rewriting the app.

## For app authors

### 1. Describe actions (backend/manifest.json)

Three optional fields per action:

```json
{
  "version": 1,
  "actions": {
    "pipeline-summary": { "handler": "summary.py", "runtime": "python", "effect": "read" },
    "draft-message": {
      "handler": "draft.py", "runtime": "python", "effect": "write",
      "input": { "type": "object", "properties": { "lead": { "type": "string" }, "tone": { "type": "string", "enum": ["warm", "direct"] } }, "required": ["lead"] }
    },
    "send-messages": { "handler": "send.py", "runtime": "python", "effect": "external", "runsOn": "mac" }
  }
}
```

| Field | Values | What it changes |
|---|---|---|
| `effect` | `read` · `write` (default) · `external` | `external` actions always ask for approval on a card. Only `read` actions can back status cards (and become read-only tools in PR 2). |
| `runsOn` | `cloud` (default) · `mac` | The card says "Runs on your Mac when it's awake". |
| `input` | flat JSON Schema object (string, number, integer, boolean, enum) | Default action cards render it as a form; PR 2 uses it as the tool schema. Params still arrive as strings. |

### 2. Opt in (metadata.json)

```json
"claude": {
  "enabled": true,
  "summary": "Find warm leads on LinkedIn and draft outreach",
  "views": {
    "status": { "kind": "status", "from": "pipeline-summary" },
    "draft":  { "kind": "action", "action": "draft-message" },
    "send":   { "kind": "approval", "action": "send-messages" },
    "inbox":  { "entry": "cards/inbox.ts", "title": "Replies" }
  }
}
```

The three **default views** need no UI code:

- `status` runs a read action and shows its JSON result as a number, key/values or a table.
- `action` builds a form from `input` and gives it one button.
- `approval` shows what's being proposed (from the tool's data) and won't run until Approve is clicked.

A **custom view** is any file under `cards/` that uses the card kit. Existing app code works unchanged inside it: `fetch('/api/db/query')`, `fetch('/api/app/backend/x')` and `subscribeJobEvents` all keep working.

```ts
import { card } from "/__papr__/papr-card.ts";

card({
  primary: { label: "Send replies", action: "send-messages", effect: "external" },
  async render({ body }) {
    const r = await fetch("/api/db/query", { method: "POST", body: JSON.stringify({ sql: "SELECT count(*) n FROM replies WHERE status='draft'" }) });
    const { rows } = await r.json();
    body.innerHTML = `<p>${rows[0].n} replies ready</p>`;
  },
});
```

The kit owns the frame:
- the header shows the app tile, name, publisher and "Built on Papr";
- the footer has at most one primary button plus **Open in Papr**;
- it follows Claude's light/dark theme;
- `effect: 'external'` adds the approval step automatically.

## How it works

| Piece | File | Notes |
|---|---|---|
| Host bridge | `src/resources/mini-app-sdk/papr-mcp-bridge.ts` | Speaks the MCP Apps messages directly (~3 KB) instead of bundling ext-apps `App` with the MCP SDK and zod (~330–430 KB). Tests check it against ext-apps' own `AppBridge`. |
| Transport | `papr-mcp-transport.ts` | `fetch('/api/*')` → `papr_api`. `EventSource('/api/jobs/events')` → polls `/api/jobs/status/:id` and fires the same `jobs:status-changed` events. Requests made before the tool result arrives wait for it. |
| Card kit | `papr-card.ts`, `papr-card-style.ts` | Frame, theme, approval gate, Mac notice, Open in Papr, `tellClaude()` (`ui/update-model-context`). |
| Default views | `papr-card-views.ts` | `statusView`, `actionView`, `approvalView`. |
| Contract | `src/gateway/services/mcp/cardContract.ts`, `appBackendManifest.ts` | Errors are written for app authors. Views are checked against the backend actions. |
| Builder | `src/gateway/services/mcp/cardBuild.ts` | One self-contained HTML per view in `dist/cards/`, plus `cards.json`. Rejects external `<script src>` and stylesheets. Warns above 150 KB and fails above 1 MB. Default cards are about 13 KB. |
| Publish | `prepareAppsForCloud.ts` | Builds cards after the backend bundle. A card failure never blocks publish. Turning Claude off removes `dist/cards`. |
| Serving | `server.ts` → `ui://papr/app/{namespaceId}/{slug}/{view}` | Read through the host's normal app-file route as the signed-in user, so the same per-app access rules apply. |

## Not in this PR

- **Per-app tools pointing at these card URIs (PR 2).** `papr_open_app` still renders the spike card.
- **`validate_app` card checks and `create_app` scaffolding of `metadata.claude` (PR 2).**
- **Live database-change events (`onDbChanged`) inside cards.** Polling covers job status only. Cards refresh after their own actions.
