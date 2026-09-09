import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "path";
import { existsSync, promises as fs } from "fs";
import {
  bootstrapMarkerPath,
  readBootstrapPendingMarker,
} from "../src/gateway/services/tursoReplica/tursoReplicaBootstrapMarker.js";
import {
  preparePortableReplicaDatabases,
  prepareReplicaForPortableTransfer,
} from "../src/gateway/services/tursoReplica/portableReplicaBootstrap.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("portableReplicaBootstrap", () => {
  const workspace = useIsolatedPaprWorkspace("portable-replica");
  let originalReplicaEnv: string | undefined;

  beforeEach(() => {
    originalReplicaEnv = process.env.PAPR_TURSO_REPLICA_SYNC;
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
  });

  afterEach(() => {
    if (originalReplicaEnv === undefined) {
      delete process.env.PAPR_TURSO_REPLICA_SYNC;
    } else {
      process.env.PAPR_TURSO_REPLICA_SYNC = originalReplicaEnv;
    }
  });

  test("prepareReplicaForPortableTransfer writes marker and removes sidecars", async () => {
    const dbPath = path.join(workspace.paprHome, "data", "databases", "solo", "data.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, "sqlite-bytes", "utf8");
    await fs.writeFile(`${dbPath}-info`, "stale-sidecar", "utf8");

    const prepared = prepareReplicaForPortableTransfer(
      dbPath,
      "cross_namespace_copy",
      workspace.paprHome,
    );
    expect(prepared).toBe(true);
    expect(existsSync(bootstrapMarkerPath(dbPath))).toBe(true);
    expect(existsSync(`${dbPath}-info`)).toBe(false);

    const marker = readBootstrapPendingMarker(dbPath);
    expect(marker?.reason).toBe("cross_namespace_copy");
  });

  test("preparePortableReplicaDatabases targets replica registry DBs in paprHome", async () => {
    const dbId = "db-portable-test";
    const slug = "portable-slug";
    const dbPath = path.join(workspace.paprHome, "data", "databases", slug, "data.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, "sqlite-bytes", "utf8");
    await fs.writeFile(`${dbPath}-info`, "stale-sidecar", "utf8");

    await fs.mkdir(path.join(workspace.paprHome, "data"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.paprHome, "data", "databases.json"),
      JSON.stringify(
        {
          version: 1,
          databases: {
            [dbId]: {
              dbId,
              localPath: dbPath,
              tursoShortName: "d-portable",
              isolation: "shared",
              status: "active",
              syncMode: "replica",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await preparePortableReplicaDatabases({
      paprHome: workspace.paprHome,
      registryDbIds: [dbId],
      reason: "portable_install",
    });

    expect(result.preparedDbIds).toEqual([dbId]);
    expect(existsSync(bootstrapMarkerPath(dbPath))).toBe(true);
    expect(existsSync(`${dbPath}-info`)).toBe(false);
  });
});
