# PR 2 · Per-app Claude tools

Each published card view becomes its own Claude tool, so Claude can pick
"LinkedIn Outreach · status" by name instead of being handed a link.

## What Claude sees

| Tool | From | Card |
|---|---|---|
| `linkedin-outreach_status` | view `status` | `ui://papr/app/{ns}/linkedin-outreach/status` |
| `linkedin-outreach_draft` | view `draft` (action) | form, prefilled from the tool's arguments |
| `linkedin-outreach_send` | view `send` (approval) | proposal; runs only on Approve |
| `papr_list_apps` | — | none (text + structured list) |
| `papr_open_app` | — | generic card for any app link |
| `papr_api` | — | hidden from the model (cards only) |

- **Every generated tool only opens a card**, so all are `readOnlyHint: true`.
  Changes happen from a button on the card; `effect: "external"` needs Approve.
- Names: `{slug}_{view}`, `[a-z0-9_-]`, ≤64 chars, deduped (`-2`) across workspaces, never shadowing `papr_*`. Deterministic.
- Descriptions come from the action's `description`, `metadata.claude.summary`, view title, and `runsOn: mac`.
- Tool inputs: the action's `input` schema. Approval tools keep `required`; action tools make everything optional (prefill).
- Cap: 60 tools (most recently published apps first). `papr_list_apps` still lists the rest.

## Catalog

`catalog.ts`, per user, cached 60s:

1. memory `GET /v1/cloud/apps/accessible` (Papr-ai/memory#208): own apps + team/public apps in the caller's workspaces.
2. For each (newest 50, 8 at a time): `dist/cards/cards.json` through the host's app-file route **as the caller**, so access is checked again by the same rules as apps.papr.ai.
3. `cards.json` is treated as untrusted and re-validated.

Only `tools/list` and per-app `tools/call` load it. Card traffic (`papr_api`, `resources/read`) skips it. If memory is down, Papr's generic tools still work.

`cards.json` now carries each view's `actionSpec` (name, description, effect, runsOn, input), so the MCP server never parses the backend manifest.

## validate_app

New rule `claude-cards`, silent unless `metadata.claude.enabled`:

- **errors**: the exact publish-time build (`buildAppCards`): bad config, unknown actions, non-`read` status sources, card build/CSP/size failures. Card source errors point at `cards/x.ts:line`.
- **warnings**: >6 views, missing `summary`, approval on an action without `effect: "external"`, action without `description`.

## Bug fixed: `metadata.claude` was wiped on save

`writeCloudAppMetadataFile` rebuilds metadata.json from the registry, which never stored `claude`, so any rename/icon change dropped it.
It now carries author-owned keys (`AUTHOR_OWNED_METADATA_KEYS = ["claude"]`) from the file on disk.

## Agents

`agent-docs/CLAUDE_CARDS_GUIDE.md` (routed from START-HERE, the SystemPrompt doc table and the `create_app` description) tells agents how to add views, describe actions, validate and publish.

## Tests

`appTools.test.ts` (18): naming, sanitizing, collisions, cap, determinism, descriptions, zod conversion, results, untrusted cards.json, catalog ordering/isolation/cache, metadata carry, validate_app rules, actionSpec in cards.json.
`mcpEndpoint.test.ts` (+5, e2e over real loopback): tools/list with resourceUri + hints + schemas, approval proposes without calling the backend, `papr_list_apps`, catalog skipped for card traffic and cached.
