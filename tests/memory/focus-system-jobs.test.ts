/**
 * The Daily Brief and Focus trackers are Papr Work's jobs, not the Home app's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobRecord } from "../../src/gateway/services/jobs/types.js";
import {
  DAILY_BRIEF_JOB_NAME,
  FOCUS_JOBS_FOLDER,
  FOCUS_TRACKERS_FOLDER,
  findDailyBriefJob,
  focusJobPatch,
} from "../../src/gateway/services/focusSystemJobs.js";

const HOME = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
const root = process.cwd();
const job = (over: Partial<JobRecord>): JobRecord =>
  ({ id: "x", name: "n", type: "agent", status: "idle", createdAt: "", updatedAt: "", ...over }) as JobRecord;

describe("Focus system jobs", () => {
  it("finds the native brief job before the one Home used to own", () => {
    const jobs = [
      job({ id: "home", name: DAILY_BRIEF_JOB_NAME, appIds: [HOME] }),
      job({ id: "native", name: DAILY_BRIEF_JOB_NAME, appIds: ["__standalone__"], folder: FOCUS_JOBS_FOLDER }),
    ];
    expect(findDailyBriefJob(jobs)?.id).toBe("native");
  });

  it("adopts the Home-linked brief job (keeps its id and history) and prefers default-job-id.txt", () => {
    const jobs = [
      job({ id: "a", name: DAILY_BRIEF_JOB_NAME, appIds: [HOME] }),
      job({ id: "b", name: "renamed by user", appIds: [HOME] }),
      job({ id: "a.migrated", name: DAILY_BRIEF_JOB_NAME, appIds: [HOME] }),
    ];
    expect(findDailyBriefJob(jobs)?.id).toBe("a");
    expect(findDailyBriefJob(jobs, "b")?.id).toBe("b");
    expect(findDailyBriefJob([job({ id: "a.migrated", name: DAILY_BRIEF_JOB_NAME, appIds: [HOME] })])).toBeUndefined();
  });

  it("re-links to standalone in the Focus folder and drops Home's writeDbIds", () => {
    expect(focusJobPatch({ appIds: [HOME], writeDbIds: ["db-1"] }, FOCUS_JOBS_FOLDER)).toEqual({
      appIds: ["__standalone__"],
      folder: FOCUS_JOBS_FOLDER,
      writeDbIds: [],
    });
    expect(focusJobPatch({ appIds: ["__standalone__"], folder: FOCUS_TRACKERS_FOLDER }, FOCUS_TRACKERS_FOLDER)).toEqual({});
  });

  it("bundle is standalone and the prompt never points at the Home app", () => {
    const def = JSON.parse(readFileSync(join(root, "src/resources/focus/daily-brief/job.json"), "utf8")) as {
      appIds: string[];
      folder: string;
      command: string;
    };
    expect(def.appIds).toEqual(["__standalone__"]);
    expect(def.folder).toBe(FOCUS_JOBS_FOLDER);
    expect(def.command).not.toMatch(/Home app|data-sources|sourceId/);
    expect(def.command).toContain('python3 "$JOB_DIR/save_brief.py"');
  });

  it("trackers are created standalone, not under the Home app", () => {
    const src = readFileSync(join(root, "src/gateway/services/focusTrackers.ts"), "utf8");
    expect(src).not.toContain(HOME);
    expect(src).not.toContain("DEFAULT_HOME_APP_ID");
  });

  it("an old Home data source cannot re-attach a Focus job to the Home app", () => {
    const src = readFileSync(join(root, "src/gateway/services/JobsService.ts"), "utf8");
    const fn = src.slice(src.indexOf("async ensureJobLinkedToApp("), src.indexOf("private async validateAppIdsExist"));
    expect(fn).toMatch(/job\.folder === "focus" \|\| job\.folder === "focus-trackers"/);
  });

  it("save_brief.py talks to /api/focus only", () => {
    const py = readFileSync(join(root, "src/resources/focus/daily-brief/save_brief.py"), "utf8");
    expect(py).toMatch(/\/api\/focus\//);
    expect(py).not.toMatch(/APP_ID|\/api\/db\//);
  });
});
