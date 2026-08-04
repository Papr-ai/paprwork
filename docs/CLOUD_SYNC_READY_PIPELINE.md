# Cloud sync → web ready pipeline

Published mini-apps on `apps.papr.ai` depend on three layers staying aligned. Users and agents should only need **Sync now** plus a normal browser refresh — not manual republish, cache tricks, or knowledge of internal artifacts.

## Mental model

| Layer | What it carries | Updated by |
|-------|-----------------|------------|
| **Git repo** | `dist/app.js`, `backend/bundle.json`, `requirements.json`, `apps/{id}/.papr-cloud-revision`, `data/cloud-repo-head.txt` (legacy fallback) | Sync now (before commit) |
| **Publish catalog** | Vault allowlist, share URL, visibility | Auto-republish after push (drift detection) |
| **Edge cache** | Cached repo files on cloud app host | Per-app `.papr-cloud-revision` (dist hash) + dist `?v=` query |

If any layer is stale, the web app breaks in confusing ways (old UI, vault 400, backend hash mismatch). The pipeline below keeps all three in step.

## Always-on requirement (no desktop)

Published apps on `apps.papr.ai` **must stay live with Paprwork closed**. Desktop is only the **publisher** (git push + one-time catalog registration), not a runtime dependency.

| Component | Always on? | Role |
|-----------|------------|------|
| Cloud App Host | Yes | Serves HTML/JS/API |
| Memory server | Yes | Publish catalog (MongoDB), repo-file via **GitHub App** (auto-refreshed tokens), Turso tokens |
| GitHub repos | Yes | Stores synced app code |
| Turso | Yes | Database rows |
| Paprwork desktop | **No** | Push updates; not required for visitors |

If an app shows "Not found" while desktop is closed, that is a **bug** — usually missing git artifacts (`dist/app.js`, `linked-databases.json`), publish catalog drift, or (fixed) Cloud App Host **negative caching** of 404 repo-file responses.

Heartbeat from desktop is **only** for cloud job scheduler deferral when the Mac is awake — not for keeping web apps alive.

## Single user action: Sync now

`CloudSyncService.pushAppNow(appId)` (UI: **Sync now** on the publish bar):

### Before git commit — `prepareAppForCloudGitSync`

File: `src/gateway/services/cloudSync/prepareAppsForCloud.ts`

1. Merge `backend/manifest.json` keys into `requirements.json`
2. Rebuild `dist/app.js` (bundled apps)
3. Rebuild `backend/bundle.json` (handler SHA256 fingerprints)
4. Write `apps/{id}/.papr-cloud-revision` (dist bundle hash — busts cache for **this app only**)
5. Stage the full app folder and commit + push
6. Amend `data/cloud-repo-head.txt` with current git HEAD (legacy fallback for apps not yet re-synced)

### After git push — `runPostSyncHooks`

1. Turso push for linked job DBs (async)
2. **Auto-republish** synced app(s) when publish catalog drift is detected (API keys, sharing, slug)
3. UI shows **Updating cloud…** while republish runs (`cloudPublishing` on `/api/sync/status`)

### On the web

User refreshes the browser tab (normal F5). Cloud app host serves fresh repo content and versioned `dist/app.js`.

**Open tabs:** Stay on the previous bundle until the user refreshes (standard static hosting, same as Vercel). After Sync now, desktop gateway notifies `apps.papr.ai` to invalidate server-side caches so the **next** load gets the new bundle.

**Optional version nudge (no SSE):** Injected `papr-version-check.js` compares `<meta name="papr-app-revision">` to `__papr__/app-revision.json` **once on first tab focus** and shows “New version available — refresh?” if sync happened while the tab was open. Paprwork’s publish-bar **Refresh** runs the same check before reloading web preview.

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
- `notifyCloudAppRevision.ts` / `notifySyncedAppRevisions.ts` — desktop → cloud cache invalidation on sync
- `publishedAppRevision.ts` — revision meta + `__papr__/app-revision.json` (cache busting on reload)
- `papr-version-check.ts` — one-shot focus check + refresh prompt (no SSE)
- `cloudAppHostCache.ts` / `cloudAppHostRequestCache.ts` — host-side cache (deploy separately)

## Deploy notes

- **Desktop gateway** — restart after pulling these changes
- **Cloud app host** — deploy for F5 cache bypass and dist query versioning to take effect on production
