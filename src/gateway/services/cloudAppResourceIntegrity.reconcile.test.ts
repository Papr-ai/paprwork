/**
 * Regression: publish reconcile must fail closed.
 *
 * An unreadable / mid-write databases.json used to read as `{ databases: {} }`,
 * so every dbId-linked source looked "missing" and reconcileAppDataSourcesForPublish
 * rewrote the local data-sources.json to `{ "sources": [] }` — breaking the app
 * with `404 No data sources linked` and uploading the empty file to cloud.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileAppDataSourcesForPublish } from "./cloudAppResourceIntegrity.js";

const APP_ID = "b0a164c2-cfe0-415f-88d1-de867d96d337";
const JOB_A = "b6d2f0ea-6a97-495a-8d69-3582d31a670f";
const JOB_B = "686d5ffa-e7c5-4eae-87f6-257698319224";

let paprDir: string;

function source(jobId: string, dbId: string, alias: string) {
  return { id: `${jobId}:${alias}`, type: "sqlite", jobId, alias, dbPath: "", tables: [], dbId };
}

async function writeJson(rel: string, value: unknown): Promise<void> {
  const full = path.join(paprDir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(value, null, 2), "utf8");
}

async function readSources(): Promise<unknown[]> {
  const raw = await readFile(path.join(paprDir, "apps", APP_ID, "data-sources.json"), "utf8");
  return (JSON.parse(raw) as { sources: unknown[] }).sources;
}

function registry(dbIds: string[]) {
  return {
    version: 1,
    databases: Object.fromEntries(
      dbIds.map((dbId) => [dbId, { dbId, name: dbId, status: "active", localPath: "" }]),
    ),
  };
}

beforeEach(async () => {
  paprDir = await mkdtemp(path.join(os.tmpdir(), "papr-reconcile-"));
  for (const jobId of [JOB_A, JOB_B]) {
    await writeJson(`Jobs/${jobId}/job.json`, { id: jobId, appIds: [APP_ID] });
  }
  await writeJson("data/jobs.json", { jobs: [JOB_A, JOB_B].map((id) => ({ id, appIds: [APP_ID] })) });
  await writeJson(`apps/${APP_ID}/data-sources.json`, {
    sources: [source(JOB_A, "db-0a2adba9", "Data Room DB"), source(JOB_B, "db-2ef11977", "Publish")],
  });
});

afterEach(async () => {
  await rm(paprDir, { recursive: true, force: true });
});

describe("reconcileAppDataSourcesForPublish — fail closed", () => {
  it("keeps every source when databases.json is missing", async () => {
    const report = await reconcileAppDataSourcesForPublish(paprDir, APP_ID);
    expect(report.changed).toBe(false);
    expect(report.removedDbIds).toEqual([]);
    expect(await readSources()).toHaveLength(2);
  });

  it("keeps every source when databases.json is truncated mid-write", async () => {
    await mkdir(path.join(paprDir, "data"), { recursive: true });
    await writeFile(path.join(paprDir, "data", "databases.json"), '{"version":1,"databa', "utf8");
    const report = await reconcileAppDataSourcesForPublish(paprDir, APP_ID);
    expect(report.changed).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/unreadable or empty/);
    expect(await readSources()).toHaveLength(2);
  });

  it("keeps every source when the registry is empty but the app links registry dbIds", async () => {
    await writeJson("data/databases.json", registry([]));
    const report = await reconcileAppDataSourcesForPublish(paprDir, APP_ID);
    expect(report.changed).toBe(false);
    expect(await readSources()).toHaveLength(2);
  });

  it("still prunes a genuinely missing dbId when the registry is trustworthy", async () => {
    await writeJson("data/databases.json", registry(["db-0a2adba9"]));
    const report = await reconcileAppDataSourcesForPublish(paprDir, APP_ID);
    expect(report.changed).toBe(true);
    expect(report.removedDbIds).toEqual(["db-2ef11977"]);
    const kept = (await readSources()) as Array<{ dbId: string }>;
    expect(kept.map((s) => s.dbId)).toEqual(["db-0a2adba9"]);
  });

  it("refuses to write a result that drops every source", async () => {
    await writeJson("data/databases.json", registry(["db-unrelated"]));
    const report = await reconcileAppDataSourcesForPublish(paprDir, APP_ID);
    expect(report.changed).toBe(false);
    expect(report.removedDbIds).toEqual([]);
    expect(report.warnings.join(" ")).toMatch(/Refused to remove all 2 data sources/);
    expect(await readSources()).toHaveLength(2);
  });
});
