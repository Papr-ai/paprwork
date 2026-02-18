# Portable Bundle Spec (Mini-Apps + Jobs + SQLite)

This spec defines how users can package and share a mini-app together with dependent jobs and database schemas.
Goal: make local sharing easy now, and cloud sync/deploy straightforward later.

## Design Goals

- Portable: copy/share a single bundle folder.
- Deterministic: schema/versioned manifests and migrations.
- Cloud-ready: explicit sync root and deployment profiles.
- Backward-compatible: works with current local layout while enabling migration to a unified root.

## Bundle Root

Recommended portable root:

`~/PAPR/bundles/{bundleId}/`

Runtime storage is now aligned under `~/PAPR` as well:

- Apps: `~/PAPR/apps`
- Jobs: `~/PAPR/jobs`
- Indexes: `~/PAPR/data/*.json`

Legacy locations are migrated forward during service initialization when needed.

## Folder Contract

```text
{bundleId}/
  manifest.json
  apps/
    {appId}/
      index.html
      app.js
      style.css
      ...other assets
  jobs/
    {jobId}/
      job.json
      code/
      logs/
      migrations/
      data.db
  schemas/
    sqlite/
      {dbId}.sql
```

## Manifest Contract

The canonical schema lives in:

- `src/core/types/bundles.ts`
  - `BundleManifestSchema`
  - `parseBundleManifest()`
  - `BUNDLE_SCHEMA_VERSION`

Core fields:

- `schemaVersion`
- `bundleId`, `name`, `version`
- `app` (entry mini-app metadata/path)
- `jobs[]` (runtime, dependency, output tables)
- `sqlite[]` (db path, migration path, table/index declarations)
- `deploymentProfiles[]` (local/cloud/hybrid execution options)
- `sync` (preferred root + cloud-ready flags)

## Example `manifest.json`

```json
{
  "schemaVersion": "1.0.0",
  "bundleId": "bundle-twitter-intel",
  "name": "Twitter Intelligence Suite",
  "version": "1.0.0",
  "createdAt": "2026-02-13T00:00:00.000Z",
  "minPaprworkVersion": "2.0.0",
  "app": {
    "id": "app-twitter-dashboard",
    "name": "Twitter Dashboard",
    "version": "1.0.0",
    "entryFile": "index.html",
    "appPath": "apps/app-twitter-dashboard"
  },
  "jobs": [
    {
      "id": "job-scraper",
      "name": "Tweet Scraper",
      "type": "python",
      "entryPoint": "code/scraper.py",
      "outputTables": ["tweets"]
    },
    {
      "id": "job-insights",
      "name": "Insights Generator",
      "type": "agent",
      "dependsOn": [
        { "jobId": "job-scraper", "onStatus": ["completed"] }
      ],
      "outputTables": ["insights"]
    }
  ],
  "sqlite": [
    {
      "id": "main",
      "path": "jobs/job-scraper/data.db",
      "migrationsPath": "jobs/job-scraper/migrations",
      "tables": [
        {
          "name": "tweets",
          "primaryKey": "id",
          "columns": ["id", "text", "created_at"],
          "indexes": [
            { "name": "idx_tweets_created", "columns": ["created_at"], "unique": false }
          ]
        }
      ]
    }
  ],
  "deploymentProfiles": [
    {
      "id": "local-default",
      "name": "Local Default",
      "runtimeTarget": "local",
      "environment": {}
    }
  ],
  "sync": {
    "preferredRoot": "~/PAPR",
    "bundleSubpath": "bundles",
    "cloudReady": true
  }
}
```

## Sharing Workflow (Future-ready)

1. Export bundle folder + manifest.
2. Import validates `manifest.json` using `BundleManifestSchema`.
3. Import runner creates missing job/app folders.
4. SQLite migration runner applies `migrations/` before first run.
5. Runtime environment mappings (keys/secrets) are prompted per deployment profile.

## Cloud Migration Strategy

- Keep bundle manifest and folder contract identical between local and cloud.
- Add storage adapters later:
  - Local filesystem adapter
  - Object storage adapter (S3/GCS/etc.)
  - Managed SQLite/Postgres adapter
- Deployment profile controls runtime target:
  - `local`
  - `cloud`
  - `hybrid`

## What this enables

- Shareable app+job+schema packages
- Reproducible imports
- Easier future sync to PAPR cloud
- Safer deploy/migrate with typed contracts
