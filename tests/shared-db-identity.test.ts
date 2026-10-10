/**
 * Team copies on a shared database: whose identity wins.
 *
 * Collaborator C installs publisher P's app with shared data. Three paths
 * resolved the wrong user or skipped the publisher's update:
 *  1. {{papr.owner_user_id}} filled with C instead of P (store no longer written).
 *  2. Get updates never replaced existing job folders (updatedAt is stripped
 *     from git, so the "newer" check was always 0 > 0).
 *  3. Per-user databases on a team copy routed to P's primary, not C's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const PUBLISHER = "PubUser001";
const COLLAB = "CollabUser9";
const PUB_APP = "11111111-1111-4111-8111-111111111111";
const LOCAL_APP = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function seedTeamCopy(
  paprHome: string,
  isolation: "shared" | "per-user",
  opts: { lineage?: boolean } = {},
): Promise<string> {
  const dbDir = path.join(paprHome, "data", "databases", "team-db");
  await fs.mkdir(dbDir, { recursive: true });
  await writeJson(path.join(paprHome, "data", "databases.json"), {
    version: 1,
    databases: {
      "db-aaaa1111": {
        dbId: "db-aaaa1111",
        localPath: path.join(dbDir, "data.db"),
        tursoShortName: "d-aaaa1111",
        isolation,
        status: "active",
        schemaOwnerAppId: PUB_APP, // publisher's app is not on this desktop
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
  const appDir = path.join(paprHome, "apps", LOCAL_APP);
  await writeJson(path.join(appDir, "metadata.json"), { id: LOCAL_APP });
  await writeJson(path.join(appDir, "data-sources.json"), {
    sources: [
      {
        id: "db-aaaa1111:team",
        type: "sqlite",
        dbId: "db-aaaa1111",
        alias: "team",
        dbPath: path.join(dbDir, "data.db"),
        tables: [],
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  if (opts.lineage !== false) {
    await writeJson(path.join(appDir, "papr-cloud-lineage.json"), {
      schemaVersion: "1.2.0",
      lineageId: "lin-1",
      mode: "track",
      databasePolicy: "shared",
      source: { orgId: "o", namespaceId: "ns-pub", userId: PUBLISHER, appId: PUB_APP, slug: "team-app" },
      installedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return dbDir;
}

async function signInAs(userId: string): Promise<void> {
  process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = userId;
  const { invalidatePaprUserIdCache } = await import("../src/gateway/utils/paprUserId.js");
  invalidatePaprUserIdCache();
  const { resetDatabaseRegistryForWorkspaceSwitch, initializeDatabaseRegistry } = await import(
    "../src/gateway/services/DatabaseRegistryService.js"
  );
  resetDatabaseRegistryForWorkspaceSwitch();
  await initializeDatabaseRegistry(); // the gateway loads it at boot

}

describe("shared database identity (collaborator on a team copy)", () => {
  const ws = useIsolatedPaprWorkspace("shared-db-identity");
  const prevUser = process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;

  afterEach(() => {
    if (prevUser === undefined) delete process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
    else process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = prevUser;
    vi.resetModules();
  });

  it("1. owner placeholder resolves to the publisher, not the signed-in collaborator", async () => {
    const dbDir = await seedTeamCopy(ws.paprHome, "shared");
    await signInAs(COLLAB);
    const m = await import("../src/gateway/services/jobs/migrationPlaceholders.js");
    expect(await m.resolveMigrationOwnerUserId(dbDir)).toBe(PUBLISHER);
    // …so a collaborator's literal id in their own migration stays theirs.
    const sql = `INSERT INTO members (user_id) VALUES ('${COLLAB}')`;
    const owner = await m.resolveMigrationOwnerUserId(dbDir);
    expect(m.portableOwnerIdInSql(sql, owner === COLLAB ? COLLAB : undefined).replaced).toBe(0);
  });

  it("1b. publisher's own database (no team-copy lineage) still resolves to the signed-in user", async () => {
    const dbDir = await seedTeamCopy(ws.paprHome, "shared", { lineage: false });
    await signInAs(PUBLISHER);
    const m = await import("../src/gateway/services/jobs/migrationPlaceholders.js");
    expect(await m.resolveMigrationOwnerUserId(dbDir)).toBe(PUBLISHER);
  });

  it("1c. per-user database: owner is the signed-in user even on a team copy", async () => {
    const dbDir = await seedTeamCopy(ws.paprHome, "per-user");
    await signInAs(COLLAB);
    const m = await import("../src/gateway/services/jobs/migrationPlaceholders.js");
    expect(await m.resolveMigrationOwnerUserId(dbDir)).toBe(COLLAB);
  });

  it("3. per-user database on a team copy routes to the collaborator's own Turso copy", async () => {
    await seedTeamCopy(ws.paprHome, "per-user");
    await signInAs(COLLAB);
    const routing = await import("../src/gateway/services/tursoReplica/tursoReplicaRouting.js");
    const name = routing.resolveTursoDatabaseForReplicaSource({
      id: "db-aaaa1111:team",
      type: "sqlite",
      dbId: "db-aaaa1111",
      alias: "team",
      dbPath: path.join(ws.paprHome, "data", "databases", "team-db", "data.db"),
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(name).toBe(`d-aaaa1111-u-${COLLAB.slice(0, 8).toLowerCase()}`);
  });

  it("3b. per-user database the publisher owns stays on the base name", async () => {
    await seedTeamCopy(ws.paprHome, "per-user", { lineage: false });
    await signInAs(PUBLISHER);
    const routing = await import("../src/gateway/services/tursoReplica/tursoReplicaRouting.js");
    const name = routing.resolveTursoDatabaseForReplicaSource({
      id: "db-aaaa1111:team",
      type: "sqlite",
      dbId: "db-aaaa1111",
      alias: "team",
      dbPath: path.join(ws.paprHome, "data", "databases", "team-db", "data.db"),
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(name).toBe("d-aaaa1111");
  });
});

describe("2. Get updates replaces existing team-copy jobs", () => {
  const ws = useIsolatedPaprWorkspace("shared-db-jobs");
  let repo: string;

  beforeEach(async () => {
    repo = path.join(ws.homeDir, "repo");
    // Publisher repo as published: config-only job.json (runtime stripped, no updatedAt).
    const pubJob = {
      id: JOB,
      name: "Sync",
      type: "python",
      appIds: [PUB_APP],
      writeDbIds: ["db-aaaa1111"],
      command: "python3 code/main.py --v2",
      schedule: { enabled: true, cron: "0 * * * *" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeJson(path.join(repo, "Jobs", JOB, "job.json"), pubJob);
    await fs.mkdir(path.join(repo, "Jobs", JOB, "code"), { recursive: true });
    await fs.writeFile(path.join(repo, "Jobs", JOB, "code", "main.py"), "print('v2')\n");
    await writeJson(path.join(repo, "data", "jobs.json"), [pubJob]);
    await writeJson(path.join(repo, "apps", PUB_APP, "data-sources.json"), {
      sources: [{ id: "j", type: "sqlite", jobId: JOB, alias: "j", dbPath: "", tables: [], linkedAt: "x" }],
    });

    // Collaborator's existing install of v1.
    const home = ws.paprHome;
    const localJob = {
      ...pubJob,
      appIds: [LOCAL_APP],
      command: "python3 code/main.py --v1",
      schedule: { enabled: false, cron: "0 * * * *" },
      reportChatId: "chat-local",
    };
    await writeJson(path.join(home, "Jobs", JOB, "job.json"), localJob);
    await writeJson(path.join(home, "Jobs", JOB, "job.runtime.json"), { status: "completed", lastRunAt: "2026-02-01T00:00:00.000Z" });
    await fs.mkdir(path.join(home, "Jobs", JOB, "code"), { recursive: true });
    await fs.writeFile(path.join(home, "Jobs", JOB, "code", "main.py"), "print('v1')\n");
    await fs.mkdir(path.join(home, "Jobs", JOB, "data"), { recursive: true });
    await fs.writeFile(path.join(home, "Jobs", JOB, "data", "data.db"), "LOCALDB");
    await fs.mkdir(path.join(home, "Jobs", JOB, "logs"), { recursive: true });
    await fs.writeFile(path.join(home, "Jobs", JOB, "logs", "run.log"), "old run");
    await writeJson(path.join(home, "data", "jobs.json"), [{ ...localJob, updatedAt: "2026-01-05T00:00:00.000Z" }]);
    await writeJson(path.join(home, "apps", LOCAL_APP, "data-sources.json"), { sources: [] });
  });

  it("brings in the publisher's job code + command, keeps local db/logs/runtime/per-machine settings", async () => {
    const { syncAppJobsToTarget } = await import("../src/gateway/services/copyAppToNamespace.js");
    const result = await syncAppJobsToTarget({
      appId: LOCAL_APP,
      sourceAppId: PUB_APP,
      sourcePaprHome: repo,
      targetPaprHome: ws.paprHome,
      installDbPolicy: "shared_primary",
      syncScope: "jobs_and_code",
    });
    const jobDir = path.join(ws.paprHome, "Jobs", JOB);
    expect(result.copiedJobIds).toContain(JOB);
    expect(await fs.readFile(path.join(jobDir, "code", "main.py"), "utf8")).toBe("print('v2')\n");
    const jobJson = JSON.parse(await fs.readFile(path.join(jobDir, "job.json"), "utf8"));
    expect(jobJson.command).toBe("python3 code/main.py --v2");
    expect(jobJson.appIds).toEqual([LOCAL_APP]); // never the publisher's app id
    expect(jobJson.schedule).toEqual({ enabled: false, cron: "0 * * * *" }); // local on/off kept
    expect(jobJson.reportChatId).toBe("chat-local");
    expect(await fs.readFile(path.join(jobDir, "data", "data.db"), "utf8")).toBe("LOCALDB");
    expect(await fs.readFile(path.join(jobDir, "logs", "run.log"), "utf8")).toBe("old run");
    expect(JSON.parse(await fs.readFile(path.join(jobDir, "job.runtime.json"), "utf8")).status).toBe("completed");
    const index = JSON.parse(await fs.readFile(path.join(ws.paprHome, "data", "jobs.json"), "utf8"));
    const entry = (Array.isArray(index) ? index : index.jobs).find((j: { id: string }) => j.id === JOB);
    expect(entry.command).toBe("python3 code/main.py --v2");
    expect(entry.appIds).toEqual([LOCAL_APP]);
    expect(entry.schedule.enabled).toBe(false);
  });
});
