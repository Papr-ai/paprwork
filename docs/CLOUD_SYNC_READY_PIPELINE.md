# Cloud sync → web ready pipeline

Published mini-apps on `apps.papr.ai` depend on three layers staying aligned. Users and agents should only need **Sync now** plus a normal browser refresh — not manual republish, cache tricks, or knowledge of internal artifacts.

## Mental model

| Layer | What it carries | Updated by |
|-------|-----------------|------------|
| **Git repo** | `dist/app.js`, `backend/bundle.json`, `requirements.json`, `data/cloud-repo-head.txt` | Sync now (before commit) |
| **Publish catalog** | Vault allowlist, share URL, visibility | Auto-republish after push (drift detection) |
| **Edge cache** | Cached repo files on cloud app host | Repo head marker + dist `?v=` query (host) |

If any layer is stale, the web app breaks in confusing ways (old UI, vault 400, backend hash mismatch). The pipeline below keeps all three in step.

## Single user action: Sync now

`CloudSyncService.pushAppNow(appId)` (UI: **Sync now** on the publish bar):

### Before git commit — `prepareAppForCloudGitSync`

File: `src/gateway/services/cloudSync/prepareAppsForCloud.ts`

1. Merge `backend/manifest.json` keys into `requirements.json`
2. Rebuild `dist/app.js` (bundled apps)
3. Rebuild `backend/bundle.json` (handler SHA256 fingerprints)
4. Stage the full app folder and commit + push
5. Amend `data/cloud-repo-head.txt` with current git HEAD (cache bust)

### After git push — `runPostSyncHooks`

1. Turso push for linked job DBs (async)
2. **Auto-republish** synced app(s) when publish catalog drift is detected (API keys, sharing, slug)
3. UI shows **Updating cloud…** while republish runs (`cloudPublishing` on `/api/sync/status`)

### On the web

User refreshes the browser tab (normal F5). Cloud app host serves fresh repo content and versioned `dist/app.js`.

## Agent guidance

- After backend or API-key changes: **Sync now** on the app — do not ask users to republish manually.
- If vault-resolve still fails after sync: key missing from Settings, or auto-publish disabled / failed (check publish prefs error).
- First-time publish still uses `publish_cloud_app`; ongoing updates use sync.

## Key files

- `prepareAppsForCloud.ts` — pre-commit preparation
- `CloudSyncService.ts` — orchestration, `lastFinalizedAppIds`, post-sync hooks
- `CloudAppPublishService.ts` — `tryAutoPublishSyncedApps({ syncedAppIds })`
- `cloudPublishDrift.ts` — catalog + sharing drift
- `cloudRepoHeadMarker.ts` — cache invalidation marker
- `cloudAppHostCache.ts` / `cloudAppHostRequestCache.ts` — host-side cache (deploy separately)

## Deploy notes

- **Desktop gateway** — restart after pulling these changes
- **Cloud app host** — deploy for F5 cache bypass and dist query versioning to take effect on production
