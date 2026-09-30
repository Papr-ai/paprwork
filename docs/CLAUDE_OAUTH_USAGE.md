# Claude subscription usage (OAuth)

Paprwork can show the same plan usage limits as [claude.ai → Settings → Usage](https://claude.ai/new#settings/usage) when the user connects via **Claude subscription OAuth** (not API key mode).

## Endpoints

1. **Primary (Bearer OAuth access token)** — same call Claude Code makes  
   `GET https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1`  
   Headers: `Authorization: Bearer sk-ant-oat01-…`, `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`

2. **Fallback (same JSON as web UI)**  
   `GET https://claude.ai/api/organizations/{org_uuid}/usage`  
   Org UUID from `GET https://api.anthropic.com/api/oauth/profile` when the OAuth usage route returns 401/403.

These routes are used by Claude Code and the claude.ai settings page; they are not part of the public Platform API docs.

## App wiring

| Layer | Location |
|-------|----------|
| Fetch + parse | `src/core/services/claudeOAuthUsage.ts` |
| Claude Code path | `src/core/services/claudeCodeUsageSource.ts` — Keychain token first, `claude auth status --json` for org id |
| IPC | `auth:claude:get-usage-limits` in `src/electron/ipc/oauth.ts` (Keychain → refresh Papr token → try each) |
| Preload | `window.electronAPI.oauth.claude.getUsageLimits()` |
| UI | `ClaudeUsageLimitsPanel` in Settings → AI Models → Claude (OAuth connected) |

## Failure modes

- **401** — Expired or invalid access token; reconnect Claude OAuth.
- **403** — Token valid for inference but not for usage; try web fallback (if profile exposes org UUID).
- **Setup/paste token without refresh** — May not work until user runs `claude auth login` (Claude Code Keychain) or pastes a fresh setup token.
- **429** — Usage API rate limit; panel retries with backoff; try again later.

Claude Code shows the same percentages in-session via `/usage` or status-line JSON; there is no documented `claude usage --json` CLI yet, so Paprwork calls the HTTP API directly with the same token store Claude Code uses.

## Context panel (composer)

When Anthropic OAuth is active, the context ring panel shows **plan usage %** from this API (not API-dollar estimates). Anthropic does **not** publish a tokens→plan-% formula — limits are dynamic (model, effort, tools, length). See [Anthropic usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work).

Session cookies from the browser are **not** required when the OAuth Bearer path succeeds.

## Tests

`tests/claude-oauth-usage.test.ts` — parser only (no live network).
