# Connections — use the user's SaaS accounts from apps, jobs and agents

Connections are one-click OAuth sign-ins to remote MCP servers (Linear, Notion,
Atlassian, Asana, HubSpot*, Stripe, Airtable, Attio, Intercom, Sentry, Supabase,
Vercel, Zapier… ~50 built in; `connect_mcp action="status"` lists ids). The user
signs in once in **Settings → Connections** (or via a Connect button in an app);
tokens live in the keychain and never reach app or job code.

Prefer a connection over asking the user for an API key whenever the service is
in the list.

## Agent (Pen / sub-agents)

- `connect_mcp({ action: "status" })` — what's connected.
- `connect_mcp({ action: "connect", server: "linear" })` — opens consent in the browser.
- Connected tools appear as `<server>__<tool>` (e.g. `linear__list_issues`). They
  are deferred: `find_tools("linear issues")` → `run_deferred_tool`.
- Sub-agent profiles with an `allowedToolIds` list must opt in:
  `"mcp:linear"` (one server) or `"mcp:*"` (every connected server).

## Mini-apps

1. **Declare** every service the app uses in `apps/<appId>/connections.json`:
   ```json
   { "connections": ["hubspot", "linear"] }
   ```
   Undeclared services are refused (403). The user approves each app × service
   once, on first use.
2. **Use the SDK** (same import as the rest of the SDK):
   ```ts
   import { papr } from '/__papr__/papr-sdk.ts';   // or '/__papr__/papr-connect.js'

   // Connect section: one button per declared service, live state.
   papr.connect.button(document.querySelector('#hubspot')!, 'hubspot', { onConnected: load });

   async function load() {
     const contacts = await papr.connect.callJson('hubspot', 'search_contacts', { query: 'acme' });
     render(contacts);
   }

   const state = await papr.connect.status(['hubspot']);   // { hubspot: 'connected' | 'disconnected' | 'needs_reauth' | … }
   ```
   - `connect(id)` opens consent and resolves when connected (rejects on cancel/timeout).
   - `call(id, tool, args)` → `{ text, structuredContent, isError }`; `callJson` parses it.
   - `tools(id)` → names + input schemas. Use it **while building** to learn argument shapes,
     or ask Pen to run `find_tools` — don't guess tool names.
3. **Design every state**: not connected (show the button, no data), `awaiting_user`
   (button says "Approve in your browser…"), `connected` (data), `needs_reauth`
   (button says Reconnect; keep last data visible).

Don'ts:
- ❌ Don't fetch `https://api.hubspot.com/...` with a pasted token — use the connection.
- ❌ Don't call `/api/mcp/servers/:id/disconnect` or add servers from an app — that's Settings only.
- ❌ Don't store tool output that contains personal data in a shared DB of a published app
  unless the app is meant to share it.

## Jobs (Python)

`papr_mcp` is on `PYTHONPATH` for every job — no install:
```python
from papr_mcp import call_json, status, PaprMcpError

if status("linear") != "connected":
    raise SystemExit("Connect Linear in Settings → Connections")
issues = call_json("linear", "list_issues", {"assignee": "me", "limit": 50})
```
Jobs never open a browser. A dead sign-in raises `PaprMcpError` ("needs to be reconnected").

## Limits (today)

- Desktop only: published apps on apps.papr.ai and cloud jobs can't use connections yet.
- *GitHub, Slack, HubSpot, Google Drive, Box, Zendesk, DocuSign, Smartsheet, Render show as
  "Soon" until Papr registers an OAuth client with them.
