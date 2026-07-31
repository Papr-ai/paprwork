# Platform Feedback API (Memory Server)

Papr Work submits in-app bug reports and feature requests through the memory server so the GitHub token never ships in the open-source desktop app.

## Client

- **Service:** `src/gateway/services/PlatformFeedbackService.ts`
- **Tool:** `create_platform_issue`
- **Auth:** User's `PAPR_API_KEY` (Papr login) via `cloudApiFetch`
- **Acting user:** `external_user_id` (Parse `_User.objectId`) merged into POST body by `cloudApiFetch` / `mergeCloudActingUserBody`

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
  "external_user_id": "ParseUserObjectId",
  "environment": {
    "appVersion": "2.0.48",
    "platform": "darwin",
    "isPackaged": true,
    "installId": "anonymous-install-uuid"
  },
  "target": {
    "appType": "paprwork"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"bug"` \| `"feature"` | yes | Maps to GitHub labels `bug` / `enhancement` |
| `title` | string | yes | 5–200 chars (validated client-side) |
| `body` | string | yes | User-authored markdown (min 20 chars client-side) |
| `contactEmail` | string | no | Server-side only (Mongo); never on public GitHub issue |
| `external_user_id` | string | no | Acting Papr user (auto-merged by desktop gateway) |
| `environment` | object | yes | App metadata from desktop gateway |
| `target.appType` | `"paprwork"` \| `"mini_app"` | no | Default `paprwork` |
| `target.namespaceId` | string | mini_app only | Published app namespace |
| `target.slug` | string | mini_app only | Published app slug |

### Success response (`200`)

```json
{
  "issueNumber": 123,
  "issueUrl": "https://github.com/Papr-ai/paprwork/issues/123",
  "title": "Bug: Chat input loses focus after job completes",
  "submissionId": "uuid-for-mongo-record"
}
```

`submissionId` references the private `app_feedback_submissions` Mongo record (submitter + owner context).

### Error responses

| Status | Meaning |
|--------|---------|
| `401` / `403` | Invalid or missing API key / org auth |
| `404` | Published mini-app not found (`target.appType=mini_app`) |
| `501` | `GITHUB_ISSUE_TOKEN` not configured on server |
| `503` | Papr Work owner env not configured (`PAPRWORK_FEEDBACK_OWNER_*`) |
| `429` | Rate limited (10/hour) |
| `502` | GitHub API failure upstream |

## Privacy

Public GitHub issues intentionally exclude email, user ids, org/ns ids, and raw install ids. Full reporter context is stored server-side in Mongo only.

## Server env (memory)

```bash
GITHUB_ISSUE_TOKEN=           # fine-grained PAT, issues:write on feedback repo
PAPR_PLATFORM_FEEDBACK_REPO=Papr-ai/paprwork  # optional
PAPRWORK_FEEDBACK_OWNER_ORG_ID=
PAPRWORK_FEEDBACK_OWNER_NAMESPACE_ID=
PAPRWORK_FEEDBACK_OWNER_USER_ID=
```

## Dev fallback (desktop only)

Developers may set `PAPR_GITHUB_ISSUE_TOKEN` in local `.env.local` when the memory server endpoint is not available. Dev GitHub bodies also omit PII. **Never embed this in packaged releases.**

## User flow

1. Settings → About → **Report Issue** / **Feature Request**
2. Agent interviews user, drafts issue
3. User confirms
4. `create_platform_issue` → memory server → GitHub + Mongo
5. User receives issue URL in chat

Users without Papr login get a draft and are prompted to sign in (Settings → AI Models).
