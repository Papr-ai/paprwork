# PR 3c: Claude picks the right Papr app (AEO for the connector)

Stacked on PR 3 (`feat/mcp-ui-accounts`). One Papr connector, each app's views as tools.
This PR is about **routing**: when a user says "help me run LinkedIn outreach", Claude should
open that Papr app, and it should stay quiet for "what's the weather".

## What changed

| Lever | Where | What |
|---|---|---|
| Routing fields | `cardContract.ts`, `cardBuild.ts`, `catalog.ts` | `metadata.claude.whenToUse` + `examples` (app and view level), carried into `cards.json` |
| Intent-first descriptions | `routing.ts` → `appTools.ts` | `Papr · {App}. Use when {whenToUse}. E.g. "…". {what the card does}` |
| No identical siblings | `routing.ts` | App-level `whenToUse` describes the **first** view only; other views use their own |
| Tool budget | `routing.ts`, `appTools.ts` | ≤3 tools per app (author order), ≤45 app tools total |
| Server instructions | `routing.ts`, `server.ts` | Lists up to 15 of the user's apps by intent; catalog now loads on `initialize` (cached 60s per user) |
| Publish lint | `routing.ts` → `cardValidation.ts` | **Blocks** over-broad ("any task", "always use this", "anything") and keyword-stuffed text. Warns on missing/short text, duplicate examples, >3 views |
| Per-app connector URL | `server.ts`, `auth.ts` | `POST /mcp/a/{namespaceId}/{slug}`: same sign-in, only that app's tools. `papr_list_apps` returns `connectorUrl` |
| Routing eval | `routingEval.ts`, `routing-eval/*.json`, `scripts/mcp-routing-eval.ts` | 42 prompts (14 negatives) vs. Papr tools + 7 distractor tools (Gmail, Calendar, web search, Notion, Drive) |
| Agent guide | `CLAUDE_CARDS_GUIDE.md` | How to write `whenToUse`/`examples`; what blocks publish |

### Per-app URL and OAuth

The scoped URL reuses the `/mcp` resource and Auth0 audience. Its protected-resource metadata
(`/.well-known/oauth-protected-resource/mcp/a/{ns}/{slug}`) advertises `resource: …/mcp`, which is
a path prefix of the scoped URL; the MCP SDK client accepts that (`checkResourceAllowed`, tested).
**Verify on staging that claude.ai's client accepts it too** before shipping an "Add to Claude" button.

## Eval results (live, Anthropic Messages API)

`npx tsx scripts/mcp-routing-eval.ts --arm both [--scale] [--opaque] [--runs N] [--model …]`

`baseline` = PR 2 descriptions + static instructions. `routed` = this PR.

| Scenario | Model | Runs | Baseline recall | Routed recall | False positives (both arms) |
|---|---|---|---|---|---|
| 5 apps, descriptive names | claude-sonnet-4-5 | 3 | 96.4% | **100%** | 0% |
| 15 apps, scored apps renamed to codenames | claude-sonnet-4-5 | 2 | 98.2% | **100%** | 0% |
| 15 apps, codenames | claude-haiku-4-5 | 1 | 89.3% | **96.4%** | 0% |

On Haiku the baseline sent "help me run outreach on LinkedIn" to `papr_list_apps` (the app is named
"Atlas"), "find me some fintech CTOs" to `web_search`, and "prep me for my 2pm" to Calendar. Routed fixed all three.

On Sonnet, what the baseline missed: "summarize what we decided on the pricing call" → `gmail_search`,
"brief me before the investor meeting tomorrow" → `calendar_list_events`. Both are other connectors
winning Papr's request. That is the case intent-first descriptions fix.

The first version of this PR **regressed** one case ("find me some fintech CTOs" → the *send* tool),
because every view inherited the app's `whenToUse` and sibling tools became identical. Fixed by
inheriting only on the primary view (see `routingLead`).

### Limits

- Single-turn, first tool call only. Multi-turn flows ("send that one") aren't covered.
- Claude.ai's real system prompt and the user's real connector mix aren't public; we use a neutral
  stand-in and 7 common distractors.
- 42 hand-written prompts. Gains are small on Sonnet because the PR 2 descriptions were already
  decent. The bigger value is the regression guard plus the lint keeping over-broad apps out.
- **Next:** replace hand-written prompts with real ones from `papr_*` tool-call logs once the
  connector is live (opt-in, anonymized). Run the eval in CI on changes to `routing.ts`/`appTools.ts`
  (needs an `ANTHROPIC_API_KEY` secret; ~$0.10 per run).

## Not in this PR

- `papr_find_apps` across the user's apps + Community (PR 3b; its description goes through this eval).
- "Add to Claude" button on apps.papr.ai pages and `SoftwareApplication` / `llms.txt` (web AEO).
