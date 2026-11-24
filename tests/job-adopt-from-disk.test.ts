/**
 * #500 — reinstalled app's jobs were silently dropped: tombstones from an earlier
 * install, and installs that wrote jobs.json behind the running JobsService.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  addJobTombstones,
  clearJobTombstones,
  readJobTombstones,
} from "../src/gateway/services/jobs/jobTombstones.js";
import {
  getJobsService,
  resetJobsServiceSingletonForTests,
} from "../src/gateway/services/JobsService.js";

describe("adopt job folders into the live registry", () => {
  const ws = useIsolatedPaprWorkspace("job-adopt-from-disk");
  const appId = randomUUID();

  beforeEach(async () => {
    resetJobsServiceSingletonForTests();
    await fs.mkdir(path.join(ws.paprHome, "data"), { recursive: true });
    await fs.writeFile(path.join(ws.paprHome, "data", "jobs.json"), "[]");
  });
  afterEach(() => resetJobsServiceSingletonForTests());

  async function writeJobFolder(id: string, extra: Record<string, unknown> = {}) {
    const dir = path.join(ws.paprHome, "Jobs", id);
    await fs.mkdir(path.join(dir, "code"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "job.json"),
      JSON.stringify({
        id,
        name: "LinkedIn Connection Sender",
        type: "python",
        appIds: [appId],
        command: "python3 code/run.py",
        schedule: { enabled: true, cron: "5 9 * * *" },
        createdAt: "2026-09-03T00:00:00.000Z",
        ...extra,
      }),
    );
    return dir;
  }

  it("clearJobTombstones removes only the given ids and reports them", async () => {
    await addJobTombstones(ws.paprHome, ["a", "b", "c"]);
    const cleared = await clearJobTombstones(ws.paprHome, ["b", "zzz"]);
    expect(cleared).toEqual(["b"]);
    const left = await readJobTombstones(ws.paprHome);
    expect([...left].sort()).toEqual(["a", "c"]);
  });

  it("reloadJobs registers an orphaned job folder that is missing from jobs.json", async () => {
    const id = randomUUID();
    await writeJobFolder(id);
    const svc = getJobsService();
    await svc.initialize();
    await svc.waitForStartupMaintenance();
    // Simulate the bug: the service saved its own list over jobs.json, entry gone.
    await fs.writeFile(path.join(ws.paprHome, "data", "jobs.json"), "[]");
    await svc.reloadJobs();
    expect(svc.hasJob(id)).toBe(true);
    const index = JSON.parse(
      await fs.readFile(path.join(ws.paprHome, "data", "jobs.json"), "utf8"),
    ) as Array<{ id: string }>;
    expect(index.map((j) => j.id)).toContain(id);
  });

  it("reloadJobs does NOT resurrect a tombstoned job folder", async () => {
    const id = randomUUID();
    await writeJobFolder(id);
    await addJobTombstones(ws.paprHome, [id]);
    const svc = getJobsService();
    await svc.initialize();
    await svc.waitForStartupMaintenance();
    await svc.reloadJobs();
    expect(svc.hasJob(id)).toBe(false);
  });

  it("install path (clearTombstones) lifts a tombstone from an earlier install and registers the job", async () => {
    const id = randomUUID();
    await writeJobFolder(id);
    await addJobTombstones(ws.paprHome, [id]);
    const svc = getJobsService();
    await svc.initialize();
    await svc.waitForStartupMaintenance();
    expect(svc.hasJob(id)).toBe(false);

    const res = await svc.adoptJobsFromDisk([id], { clearTombstones: true });
    expect(res.untombstoned).toEqual([id]);
    expect(res.adopted).toEqual([id]);
    expect(svc.hasJob(id)).toBe(true);
    expect((await svc.getJob(id))?.schedule?.cron).toBe("5 9 * * *");
    // The scheduler must actually see it: nextRunAt computed, job in the index.
    expect((await svc.getJob(id))?.scheduleState?.nextRunAt).toBeTruthy();
    const countBefore = svc.getScheduleIndexScheduledCount();
    expect(countBefore).toBeGreaterThanOrEqual(1);
    const farFuture = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    expect(svc.getDueScheduledJobIds(farFuture)).toContain(id);

    // Survives a later reload (the original bug: the next reload dropped it again).
    await svc.reloadJobs();
    expect(svc.hasJob(id)).toBe(true);
    expect((await readJobTombstones(ws.paprHome)).has(id)).toBe(false);
  });

  it("never adopts a folder whose job.json id differs from the folder name", async () => {
    const folder = randomUUID();
    await writeJobFolder(folder, { id: randomUUID() });
    const svc = getJobsService();
    await svc.initialize();
    await svc.waitForStartupMaintenance();
    const res = await svc.adoptJobsFromDisk([folder], { clearTombstones: true });
    expect(res.adopted).toEqual([]);
    expect(svc.hasJob(folder)).toBe(false);
  });
});

describe("track Get updates keeps deliberately deleted jobs deleted", () => {
  const ws = useIsolatedPaprWorkspace("job-adopt-update");
  beforeEach(async () => {
    resetJobsServiceSingletonForTests();
    await fs.mkdir(path.join(ws.paprHome, "data"), { recursive: true });
    await fs.writeFile(path.join(ws.paprHome, "data", "jobs.json"), "[]");
  });
  afterEach(() => resetJobsServiceSingletonForTests());

  it("promoteBundledAppJobsToRegistry with clearTombstones:false skips tombstoned bundled jobs", async () => {
    const { promoteBundledAppJobsToRegistry } = await import(
      "../src/gateway/services/cloudAppResourceIntegrity.js"
    );
    const localAppId = randomUUID();
    const jobId = randomUUID();
    const localAppDir = path.join(ws.paprHome, "apps", localAppId);
    await fs.mkdir(path.join(localAppDir, "jobs", jobId, "code"), { recursive: true });
    await fs.writeFile(
      path.join(localAppDir, "jobs", jobId, "job.json"),
      JSON.stringify({ id: jobId, name: "Deleted on purpose", type: "python", appIds: [localAppId], command: "python3 code/run.py" }),
    );
    await addJobTombstones(ws.paprHome, [jobId]);

    const update = await promoteBundledAppJobsToRegistry({ localAppId, localAppDir, paprHome: ws.paprHome, clearTombstones: false });
    expect(update.promotedJobIds).toEqual([]);
    expect(getJobsService().hasJob(jobId)).toBe(false);
    expect((await readJobTombstones(ws.paprHome)).has(jobId)).toBe(true);

    // Fresh install of the same app: the user asked for it again.
    const install = await promoteBundledAppJobsToRegistry({ localAppId, localAppDir, paprHome: ws.paprHome });
    expect(install.promotedJobIds).toEqual([jobId]);
    expect(getJobsService().hasJob(jobId)).toBe(true);
    expect((await readJobTombstones(ws.paprHome)).has(jobId)).toBe(false);
  });

  it("an installed scheduled job is in the scheduler index right away (#513)", async () => {
    // Real install path: promoteBundledAppJobsToRegistry → upsertJob with a
    // record rebuilt from the bundle job.json, which never has scheduleState.
    const { promoteBundledAppJobsToRegistry } = await import(
      "../src/gateway/services/cloudAppResourceIntegrity.js"
    );
    const localAppId = randomUUID();
    const jobId = randomUUID();
    const localAppDir = path.join(ws.paprHome, "apps", localAppId);
    await fs.mkdir(path.join(localAppDir, "jobs", jobId, "code"), { recursive: true });
    await fs.writeFile(
      path.join(localAppDir, "jobs", jobId, "job.json"),
      JSON.stringify({ id: jobId, name: "Connection Sender", type: "python", appIds: [localAppId], command: "python3 code/run.py", schedule: { enabled: true, cron: "5 9 * * *" } }),
    );
    const svc = getJobsService();
    await svc.initialize();
    await svc.waitForStartupMaintenance();
    const before = svc.getScheduleIndexScheduledCount();

    const res = await promoteBundledAppJobsToRegistry({ localAppId, localAppDir, paprHome: ws.paprHome });
    expect(res.promotedJobIds).toEqual([jobId]);
    expect((await svc.getJob(jobId))?.scheduleState?.nextRunAt).toBeTruthy();
    expect(svc.getScheduleIndexScheduledCount()).toBe(before + 1);
    const farFuture = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    expect(svc.getDueScheduledJobIds(farFuture)).toContain(jobId);
  });

  it("a one-shot atTime already in the past is not armed on install", async () => {
    const svc = getJobsService();
    await svc.initialize();
    await svc.waitForStartupMaintenance();
    const id = randomUUID();
    await svc.upsertJob({
      id, name: "Old one-shot", type: "bash", status: "pending", appIds: [], command: "true",
      schedule: { enabled: true, atTime: "2020-01-01T00:00:00.000Z" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);
    expect((await svc.getJob(id))?.scheduleState?.nextRunAt).toBeFalsy();
    expect(svc.getDueScheduledJobIds(new Date())).not.toContain(id);
  });
});
