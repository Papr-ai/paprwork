# Sync V3 — V2 Artifact Audit

**Date:** 2026-08-19  
**Context:** Joe Coffee Intelligence stuck "2nd in queue" for 30+ minutes while Caffe Ladro flush hung in post-flush auto-publish scanning ~74 apps. Root cause: namespace-monorepo assumptions still wired into per-app writer flush path.

---

## Fixed in this pass

| Issue | V2 assumption | V3 fix | Files |
|-------|---------------|--------|-------|
| **Post-flush auto-publish scans full catalog** | One git push touches many apps → scan all `autoPublish` prefs after every sync | `mergeAutoPublishCandidateAppIds` now has `flush` vs `catalog` scope. Per-app flush post-hook uses `flush` (synced apps only). Background heartbeat runs `catalog` recovery every 15 min when queue idle. | `cloudPublishPrefs.ts`, `CloudAppPublishService.ts`, `CloudSyncService.ts`, `backgroundAutoPublishCatalogScan.ts`, `cloudSyncHeartbeat.ts` |
| **Workspace "Sync now" flushes all apps** | Full namespace push on manual sync | `pushWorkspaceV3Now` always uses `hasRelativePathChanged` — only changed auto-upload apps flush | `pushV3Now.ts`, `cloudSyncPushApi.ts` |
| **Catalog scan triggers sync recovery flushes** | Recovery via `pushAppNow` during drift scan | `tryRecoverAppSyncForPublish` only runs in `flush` scope (after a real upload), not during background catalog scan | `CloudAppPublishService.ts` |

---

## Still acceptable (legacy read-only)

These remain for **pull / migration / hygiene** — they do not block the upload queue.

| Artifact | Location | V3 status |
|----------|----------|-----------|
| Namespace git pull (ff-only) | `cloudSyncGitPullExecution.ts`, `cloudSyncHeartbeat.ts` | OK — read path for legacy workspace metadata |
| `data/cloud-repo-head.txt` | `cloudRepoHeadMarker.ts`, `syncState.ts` | OK — fallback for apps without per-app `.papr-cloud-revision` |
| Unpushed legacy namespace commits reset | `cloudSyncGitPullExecution.ts:49` | OK — one-time migration: reset + re-flush via writer |
| `reconcileAllGitCleanSubdirs` | `cloudSyncQueueProcessor.ts` | OK — marks clean subdirs synced after legacy pull reset |
| Turso post-git reschedule label | `cloudSyncPostHooks.ts:38` (`post_git`) | Cosmetic — rename to `post_flush` when convenient |

---

## Open follow-ups (prioritized)

### P1 — UX / observability

| Issue | Location | Recommendation |
|-------|----------|----------------|
| Manual "Upload now" always full flush | `flushAppNow.ts`, `SyncCoordinator.flushNow` | ✅ Fixed — skip when code + DB already synced (unless retrying after error) |
| Queue popover doesn't show active app name | Web sync UI | Surface `readGatewaySyncBusyState().appId` in popover |
| `/api/sync/items` times out when queue saturated | Gateway index | Increase timeout or paginate; don't block on publish scan (fixed by flush scope) |

### P2 — Mental model / docs

| Issue | Location | Recommendation |
|-------|----------|----------------|
| `CLOUD_SYNC_READY_PIPELINE.md` describes post-git-push publish | `docs/` | Rewrite for per-app writer + scoped post-flush |
| Comments say "git push" in publish recovery | `CloudAppPublishService.ts:833` | Update to "writer upload" |
| `SyncCoordinator` jobs → "namespace git queue" comment | `SyncCoordinator.ts:107` | Clarify jobs route through owning app's writer flush |

### P3 — Optional cleanup (no user impact)

| Issue | Location | Recommendation |
|-------|----------|----------------|
| `pushAllAutoUploadApps` removed | was `pushV3Now.ts` | Done — use changed-only path |
| `finishQueueProcessing` → `runPostSyncHooks` with empty `lastFinalizedAppIds` | `cloudSyncQueueProcessor.ts:322` | Safe now (flush scope + empty ids = no-op). Could skip calling post-hooks when ids empty. |
| Dead helpers: `backupLocalJobDb` / `restoreLocalJobDb` | `tursoSyncBridgeCore.ts` | Remove if still unreferenced |
| Namespace git hygiene tick | `cloudSyncRepoHygieneTick.ts` | Keep until namespace repo fully retired |

---

## Behavioral matrix (after fix)

| Trigger | Apps flushed | Auto-publish scan |
|---------|--------------|-------------------|
| Auto upload (unchanged app) | Skipped (`hasItemChanged`) | N/A |
| Auto upload (changed app) | 1 app via writer | That app only (`flush` scope) |
| Manual Upload now | 1 app (full pipeline) | That app only |
| Workspace Sync now | Changed auto-upload apps only | Per flushed app in each `flushAppNow` post-hook |
| Queue idle heartbeat (15 min) | None | Full catalog + prefs recovery (`catalog` scope) |
| Queue finalize (empty ids) | None | No-op |

---

## Testing

```bash
nvm use 24
npm run test -- tests/cloud-publish-drift.test.ts
```

Manual verification:
1. Upload now on one app → post-hook completes in seconds, not minutes
2. Queue advances to next app without blocking on unrelated autoPublish prefs
3. Background catalog scan runs only when `.gateway-sync-busy.json` queue depth is 0

---

## Related docs

- `docs/SYNC_V3_AUDIT_PUNCHLIST.md` — P0/P1 coordination + failure paths (separate from this UX/queue audit)
- `docs/SYNC_CONTRACT.md` — V3 upload contract
- `docs/SYNC_V3_IMPLEMENTATION_PLAN.md` — architecture reference
