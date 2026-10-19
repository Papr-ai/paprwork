/**
 * Generated app files must be machine-independent, and a cloud sandbox must not
 * push its own machine state (title from job name, cloud-direct, null schema,
 * platform env vars) into the published app.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { portableRecord, portableSyncMode } from "./linkedDatabasesForCloud.js";
import { listRepoMigrationIds } from "./cloudAppMeta.js";
import { extractVaultEnvReferences } from "../../utils/miniAppBackendLint.js";
import { reconcileScaffoldAppEntryWithMetadata } from "../cloudAgentGateway/cloneUserRepo.js";
import { isSameMetadataIgnoringUpdatedAt } from "../cloudAppMetadataFile.js";
import type { DatabaseRecord } from "../DatabaseRegistryService.js";

const record = (over: Partial<DatabaseRecord> = {}): DatabaseRecord => ({
  dbId: "db-1",
  localPath: "/Users/me/Papr/data/databases/glow/glow.db",
  tursoShortName: "d-1",
  label: "Glow Friends",
  isolation: "shared",
  status: "active",
  syncMode: "replica",
  schemaOwnerAppId: "app-1",
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-18T18:16:01.179Z",
  lastReplicaPushAt: "2026-10-18T18:16:01.179Z",
  lastReplicaLocalMutationAt: "2026-10-18T18:15:58.330Z",
  ...over,
});

describe("linked-databases.json portable records", () => {
  it("drops paths, timestamps and replica bookkeeping", () => {
    const out = portableRecord(record()) as unknown as Record<string, unknown>;
    expect(out.localPath).toBe("");
    expect(out).not.toHaveProperty("createdAt");
    expect(out).not.toHaveProperty("updatedAt");
    expect(out).not.toHaveProperty("lastReplicaPushAt");
    expect(out).not.toHaveProperty("lastReplicaLocalMutationAt");
    expect(out.label).toBe("Glow Friends");
  });

  it("ships the database protocol, never the sandbox's cloud-direct connection", () => {
    expect(portableSyncMode("cloud-direct")).toBe("replica");
    const desktop = JSON.stringify(portableRecord(record({ syncMode: "replica" })));
    const sandbox = JSON.stringify(
      portableRecord(
        record({
          syncMode: "cloud-direct",
          localPath: "/tmp/papr-cloud-run/x/db.db",
          createdAt: "2026-10-18T17:58:00.000Z",
          updatedAt: "2026-10-18T17:58:00.000Z",
          lastReplicaPushAt: undefined,
          lastReplicaLocalMutationAt: undefined,
        }),
      ),
    );
    expect(sandbox).toBe(desktop);
  });
});

describe("requiredSchemaVersion fallback", () => {
  it("reads migration ids from the app repo", () => {
    const appDir = mkdtempSync(path.join(os.tmpdir(), "papr-meta-"));
    const dir = path.join(appDir, "databases", "glow", "migrations");
    mkdirSync(dir, { recursive: true });
    for (const f of ["0001_baseline.sql", "0004_20261010001759_task_worker_claim.sql", "snapshot.json"]) {
      writeFileSync(path.join(dir, f), "");
    }
    expect(listRepoMigrationIds(appDir)).toEqual([
      "0001_baseline",
      "0004_20261010001759_task_worker_claim",
    ]);
  });
});

describe("backend vault key detection", () => {
  it("ignores env vars Paprwork sets itself", () => {
    const refs = extractVaultEnvReferences(
      'a = os.environ.get("PAPRWORK_TELEMETRY_PAPR_USER_ID", "")\nb = os.environ.get("ELEVENLABS_API_KEY")',
    );
    expect([...refs]).toEqual(["ELEVENLABS_API_KEY"]);
  });
});

describe("sandbox app scaffold", () => {
  it("takes title/description/icon/tags from the app's metadata.json, not the job", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "papr-scaffold-"));
    mkdirSync(path.join(home, "apps", "app-1"), { recursive: true });
    mkdirSync(path.join(home, "data"), { recursive: true });
    writeFileSync(
      path.join(home, "apps", "app-1", "metadata.json"),
      JSON.stringify({ appId: "app-1", title: "Pen Glow Friends", description: "Real", icon: "<svg/>", tags: ["pen"], updatedAt: "2026-10-08T23:58:56.774Z" }),
    );
    writeFileSync(
      path.join(home, "data", "apps.json"),
      JSON.stringify([{ id: "app-1", type: "app", title: "Glow Friend Worker", description: "Published mini-app" }]),
    );
    await reconcileScaffoldAppEntryWithMetadata(home, "app-1");
    const [entry] = JSON.parse(readFileSync(path.join(home, "data", "apps.json"), "utf8"));
    expect(entry).toMatchObject({ title: "Pen Glow Friends", description: "Real", icon: "<svg/>", tags: ["pen"], updatedAt: "2026-10-08T23:58:56.774Z" });
  });
});

describe("metadata.json regenerate", () => {
  it("treats a fresh updatedAt alone as unchanged", () => {
    const base = { appId: "a", title: "T", description: "D", tags: ["x"] };
    expect(isSameMetadataIgnoringUpdatedAt({ ...base, updatedAt: "2" }, { ...base, updatedAt: "1" })).toBe(true);
    expect(isSameMetadataIgnoringUpdatedAt({ ...base, title: "New", updatedAt: "2" }, { ...base, updatedAt: "1" })).toBe(false);
  });
});

describe("registry merge from an app's linked-databases.json", () => {
  const load = async (local: Record<string, DatabaseRecord>) => {
    const { DatabaseRegistryService } = await import("../DatabaseRegistryService.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "papr-reg-"));
    const svc = new DatabaseRegistryService(dir, path.join(dir, "apps"));
    (svc as unknown as { cache: unknown }).cache = { version: 1, databases: local };
    return svc;
  };

  it("never switches a desktop replica to the sandbox's cloud-direct", async () => {
    const svc = await load({ "db-1": record() });
    svc.mergeFromRegistryFile(
      JSON.stringify({ version: 1, databases: { "db-1": record({ syncMode: "cloud-direct", label: "db-1", updatedAt: "2099-01-01T00:00:00.000Z", localPath: "" }) } }),
    );
    const out = svc.getById("db-1")!;
    expect(out.syncMode).toBe("replica");
    expect(out.localPath).toBe(record().localPath);
    expect(out.lastReplicaPushAt).toBe(record().lastReplicaPushAt);
  });

  it("takes portable changes (isolation) and protocol upgrades (legacy → replica)", async () => {
    const svc = await load({ "db-1": record({ syncMode: "legacy", isolation: "shared" }) });
    svc.mergeFromRegistryFile(
      JSON.stringify({ version: 1, databases: { "db-1": portableRecord(record({ syncMode: "replica", isolation: "per-user" })) } }),
    );
    expect(svc.getById("db-1")).toMatchObject({ syncMode: "replica", isolation: "per-user" });
  });

  it("adopts a new database as replica, not cloud-direct", async () => {
    const svc = await load({});
    svc.mergeFromRegistryFile(
      JSON.stringify({ version: 1, databases: { "db-2": record({ dbId: "db-2", syncMode: "cloud-direct", localPath: "" }) } }),
    );
    expect(svc.getById("db-2")?.syncMode).toBe("replica");
  });
});
