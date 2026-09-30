import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { applyDbIdRemapToJobs } from "../src/gateway/services/copyAppToNamespace.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

describe("applyDbIdRemapToJobs", () => {
  let testHome: string;

  beforeEach(async () => {
    testHome = path.join(
      os.tmpdir(),
      `papr-remap-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fs.mkdir(path.join(testHome, "data"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it("updates jobs.json, Jobs job.json, and bundled job.json", async () => {
    const appId = "app-11111111-1111-1111-1111-111111111111";
    const jobId = "job-22222222-2222-2222-2222-222222222222";
    const oldDb = "db-11111111";
    const newDb = "db-22222222";
    const job: JobRecord = {
      id: jobId,
      name: "Triage",
      type: "agent",
      status: "pending",
      appIds: [appId],
      writeDbIds: [oldDb],
      command: `Target ${oldDb}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await fs.writeFile(
      path.join(testHome, "data", "jobs.json"),
      JSON.stringify([job], null, 2),
      "utf8",
    );
    const canonicalDir = path.join(testHome, "Jobs", jobId);
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(
      path.join(canonicalDir, "job.json"),
      JSON.stringify(job, null, 2),
      "utf8",
    );
    const bundledDir = path.join(testHome, "apps", appId, "jobs", jobId);
    await fs.mkdir(bundledDir, { recursive: true });
    await fs.writeFile(
      path.join(bundledDir, "job.json"),
      JSON.stringify(job, null, 2),
      "utf8",
    );

    await applyDbIdRemapToJobs({
      targetPaprHome: testHome,
      appId,
      copiedJobIds: [jobId],
      dbIdRemap: new Map([[oldDb, newDb]]),
    });

    const indexJobs = JSON.parse(
      await fs.readFile(path.join(testHome, "data", "jobs.json"), "utf8"),
    ) as JobRecord[];
    expect(indexJobs[0]?.writeDbIds).toEqual([newDb]);

    const canonical = JSON.parse(
      await fs.readFile(path.join(canonicalDir, "job.json"), "utf8"),
    ) as JobRecord;
    expect(canonical.writeDbIds).toEqual([newDb]);

    const bundled = JSON.parse(
      await fs.readFile(path.join(bundledDir, "job.json"), "utf8"),
    ) as JobRecord;
    expect(bundled.writeDbIds).toEqual([newDb]);
    expect(bundled.command).toContain(newDb);
  });
});
