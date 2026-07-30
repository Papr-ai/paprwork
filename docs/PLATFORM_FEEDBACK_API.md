# Platform Feedback API (Memory Server)

Papr Work submits in-app bug reports and feature requests through the memory server so the GitHub token never ships in the open-source desktop app.

## Client

- **Service:** `src/gateway/services/PlatformFeedbackService.ts`
- **Tool:** `create_platform_issue`
- **Auth:** User's `PAPR_API_KEY` (Papr login) via `cloudApiFetch`

## Endpoint

```
POST /v1/platform-feedback/issues
```

### Headers

| Header | Value |
|--------|--------|
| `X-API-Key` | User's Papr API key |
| `Content-Type` | `application/json` |

### Request body

```json
{
  "type": "bug",
  "title": "Bug: Chat input loses focus after job completes",
  "body": "## Summary\n\nWhen a job finishes...",
  "contactEmail": "user@example.com",
  "environment": {
    "appVersion": "2.0.48",
    "platform": "darwin",
    "isPackaged": true,
    "installId": "anonymous-install-uuid"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"bug"` \| `"feature"` | yes | Maps to GitHub labels `bug` / `enhancement` |
| `title` | string | yes | 5–200 chars (validated client-side) |
| `body` | string | yes | User-authored markdown (min 20 chars client-side) |
| `contactEmail` | string | no | Only if user opted in |
| `environment` | object | yes | App metadata from desktop gateway |

### Success response (`200`)

```json
{
  "issueNumber": 123,
  "issueUrl": "https://github.com/Papr-ai/paprwork/issues/123",
  "title": "Bug: Chat input loses focus after job completes"
}
```

### Error responses

| Status | Meaning |
|--------|---------|
| `401` / `403` | Invalid or missing API key |
| `404` / `501` | Endpoint not deployed yet (client falls back to dev token or draft-only) |
| `429` | Rate limited |
| `502` | GitHub API failure upstream |

## Server implementation checklist

1. Validate API key (same as other `/v1/cloud/*` routes).
2. Rate limit per org/user (e.g. 10 submissions / hour).
3. Append environment block to issue body (server may re-format).
4. Create issue on `Papr-ai/paprwork` using server-side `GITHUB_ISSUE_TOKEN` (issues:write, single repo).
5. Attribute reporter from Papr profile email when available.
6. Return `issueNumber`, `issueUrl`, `title`.

## Dev fallback (desktop only)

Developers may set `PAPR_GITHUB_ISSUE_TOKEN` in local `.env.local` when the memory server endpoint is not available. **Never embed this in packaged releases.**

## User flow

1. Settings → About → **Report Issue** / **Feature Request**
2. Agent interviews user, drafts issue
3. User confirms
4. `create_platform_issue` → memory server → GitHub
5. User receives issue URL in chat

Users without Papr login get a draft and are prompted to sign in (Settings → AI Models).
