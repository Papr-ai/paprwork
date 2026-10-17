# Cloud app host key: off desktop + rotation

## Why
`PAPR_CLOUD_APP_HOST_KEY` authenticates apps.papr.ai and app-repo-writer to memory,
and (until now) also signed the apps.papr.ai login cookie. Since v2.4.5 it was
baked into every desktop build, so anyone with the app could extract it.

## What changed
- Desktop builds no longer contain the key (defaults JSON, generator, release CI).
- Desktop "app code changed" notices go to memory, signed in as the publisher:
  `POST /v1/cloud/apps/publish/{appId}/revision-notify` (memory checks ownership).
- Access-changed notices: memory already sent them on access edits; it now also
  sends them after `POST /v1/cloud/apps/publish`.
- DB-changed notices: desktop already reports via `/v1/cloud/runtime/turso-db-changed`.
- Login cookies are signed with `PAPR_CLOUD_APP_COOKIE_SECRET` (falls back to the
  host key until that secret exists).
- memory and apps.papr.ai accept `PAPR_CLOUD_APP_HOST_KEY_PREVIOUS` during rotation.
- apps.papr.ai, app-repo-writer and the agent gateway run as their own service
  accounts instead of the default compute account (project Editor).

## Rotation runbook (after the desktop release ships)
1. `openssl rand -base64 32` → add as a new version of `papr-cloud-app-host-key`.
2. Create `papr-cloud-app-cookie-secret` (`openssl rand -base64 32`).
3. memory: set `PAPR_CLOUD_APP_HOST_KEY` = new, `PAPR_CLOUD_APP_HOST_KEY_PREVIOUS` = old. Deploy.
4. Deploy app host (picks up new key + cookie secret; everyone signs in again once),
   app-repo-writer, agent gateway.
5. After ~10 min with no 401s in memory logs: remove `_PREVIOUS` from memory. Done.
6. Update `.env.local` copies used by e2e scripts; delete the GitHub secret
   `PAPR_CLOUD_APP_HOST_KEY` (no longer used by release CI).

Rollback: restore the old secret version and redeploy; for service accounts,
`gcloud run services update <svc> --service-account=223473570766-compute@developer.gserviceaccount.com`.
