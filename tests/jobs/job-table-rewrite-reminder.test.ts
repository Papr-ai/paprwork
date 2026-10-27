import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("tableRewriteReminderFor (create_job / update_job / job file edits)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function reminderFor(script: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "job-rw-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "code"));
    writeFileSync(path.join(dir, "code", "sync.py"), script);
    vi.doMock("../../src/gateway/services/JobsService.js", () => ({
      getJobsService: () => ({
        initialize: async () => undefined,
        getJob: async () => ({ id: "j1", type: "python", command: "python3 code/sync.py", appIds: ["app-1"] }),
        getJobPath: async () => dir,
      }),
    }));
    const { tableRewriteReminderFor } = await import("../../src/core/tools/appJobs.js");
    return tableRewriteReminderFor("j1");
  }

  it("flags a job whose script wipes and reloads a table", async () => {
    const note = await reminderFor(
      `for t in ("usage_orgs",):\n    add(f"DELETE FROM {t}")\nadd("INSERT INTO usage_orgs (a) VALUES (?)")`,
    );
    expect(note).toMatch(/deletes every row and re-inserts/);
    expect(note).toMatch(/ON CONFLICT/);
  });

  it("stays quiet for a job that upserts only what changed", async () => {
    const note = await reminderFor(
      `add("INSERT INTO usage_orgs (a) VALUES (?) ON CONFLICT(a) DO UPDATE SET a=excluded.a")\nadd("DELETE FROM usage_orgs WHERE a IN (?)")`,
    );
    expect(note).toBeUndefined();
  });
});
