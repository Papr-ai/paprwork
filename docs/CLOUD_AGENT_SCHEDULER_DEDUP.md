# Cloud agent scheduler deduplication

## Problem

Cloud scheduler can dispatch the same scheduled slot twice (retry after gateway error, overlapping ticks, or lease not held until run completes). Without a stable idempotency key, the gateway generated a **new** `runId` per POST → two full agent sessions (`job:{jobId}:{runId}`) and ~2× cost.

## Gateway fix (paprwork-v2)

1. **`scheduledDueAt`** on `CloudAgentRunRequest` — memory should send the slot ISO (`scheduleState.nextRunAt`).
2. **`resolveCloudAgentRunId`** — uses `runId` from lease when present; otherwise derives a stable 12-char id from `jobId + scheduledDueAt`.
3. **`runWithCloudAgentRunDedup`** — coalesces in-flight `/internal/agent/run` and caches successful results for 30 minutes per slot.
4. **One-shot stream guard** — second `/internal/agent/stream` for the same slot gets `duplicate_scheduled_run` (no second agent).

Warm app-agent chat (`workspaceSessionId` + `keepWorkspaceWarm`) is **not** deduped — each user message is intentional.

## Memory server contract

When invoking the cloud agent gateway for a **scheduled** agent job:

| Field | Required | Notes |
|-------|----------|--------|
| `runId` | Recommended | From `POST /v1/cloud/runtime/scheduler-run-lease/acquire` |
| `scheduledDueAt` | Recommended | Same `dueAt` passed to lease acquire |
| Retry after HTTP failure | Must reuse | Same `runId` + `scheduledDueAt` so gateway coalesces |

Desktop parity: `idempotencyKey = ${jobId}-${scheduledDueAt}` in `JobsService.runJob`.

## Deploy

Redeploy **papr-cloud-agent-gateway** after merging. Memory server should pass `scheduledDueAt` (and lease `runId`) on prepare payloads — follow-up in `memory/services/cloud_scheduler_service.py` if not already sent.
