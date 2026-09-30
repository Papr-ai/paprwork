import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import { deleteAppSyncArtifacts } from "../src/gateway/services/deleteAppSyncArtifacts.js";
import { APP_REPO_REGISTRY_CACHE_FILENAME } from "../src/core/types/appRepoRegistry.js";
import { SYNC_OID_CACHE_FILENAME } from "../src/core/types/appRepoWriterOps.js";
import { SYNC_OUTBOX_FILENAME } from "../src/core/types/appRepoWriterOps.js";
import {
  initializeDatabaseRegistry,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../src/gateway/services/DatabaseRegistryService.js";

describe("deleteAppSyncArtifacts", () => {
  const workspace = useIsolatedPaprWorkspace("delete-app-sync-artifacts");
  const appId = "11111111-1111-4111-8111-111111111111";

  beforeEach(async () => {
    resetDatabaseRegistryForWorkspaceSwitch();
    await initializeDatabaseRegistry();
  });

  it("removes sync registry, cursors, oid cache, outbox, and schema-owner DBs", async () => {
    const dataDir = path.join(workspace.paprHome, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(
      path.join(dataDir, APP_REPO_REGISTRY_CACHE_FILENAME),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          records: {
            [appId]: {
              appId,
              namespaceId: "ns-test",
              githubOrg: "papr-work",
              repoName: `app-${appId}`,
              shardId: "shard-1",
              cloneUrl: "https://example.com/clone.git",
              repoUrl: "https://example.com/repo",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(dataDir, "app-repo-commit-cursors.json"),
      JSON.stringify({
        [appId]: {
          lastCommitSha: "abc1234",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    fs.writeFileSync(
      path.join(dataDir, SYNC_OID_CACHE_FILENAME),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        apps: {
          [appId]: {
            "index.html": "oid-1",
          },
        },
      }),
    );

    fs.writeFileSync(
      path.join(dataDir, SYNC_OUTBOX_FILENAME),
      `${JSON.stringify({
        id: "outbox-1",
        appId,
        idempotencyKey: "key-1",
        files: [],
        author: "test",
        message: "test",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        attempts: 0,
      })}\n`,
    );

    const registry = await initializeDatabaseRegistry();
    const dbPath = path.join(
      workspace.paprHome,
      "data",
      "databases",
      "owned",
      "data.db",
    );
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "sqlite");
    await registry.register({
      dbId: "db-owned111",
      localPath: dbPath,
      label: "Owned DB",
      tursoShortName: "d-owned111",
      schemaOwnerAppId: appId,
    });

    const result = await deleteAppSyncArtifacts(appId, workspace.paprHome);

    expect(result.removedRepoRegistry).toBe(true);
    expect(result.removedCommitCursor).toBe(true);
    expect(result.removedOidCache).toBe(true);
    expect(result.removedOutboxEntries).toBe(1);
    expect(result.tombstonedSchemaOwnerDbs).toBe(1);

    const repoCache = JSON.parse(
      fs.readFileSync(path.join(dataDir, APP_REPO_REGISTRY_CACHE_FILENAME), "utf8"),
    ) as { records: Record<string, unknown> };
    expect(repoCache.records[appId]).toBeUndefined();

    const cursors = JSON.parse(
      fs.readFileSync(path.join(dataDir, "app-repo-commit-cursors.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(cursors[appId]).toBeUndefined();

    const oidCache = JSON.parse(
      fs.readFileSync(path.join(dataDir, SYNC_OID_CACHE_FILENAME), "utf8"),
    ) as { apps: Record<string, unknown> };
    expect(oidCache.apps[appId]).toBeUndefined();

    const outboxRaw = fs.readFileSync(path.join(dataDir, SYNC_OUTBOX_FILENAME), "utf8");
    expect(outboxRaw.trim()).toBe("");

    const owned = registry.listBySchemaOwnerApp(appId);
    expect(owned).toHaveLength(0);
  });
});
