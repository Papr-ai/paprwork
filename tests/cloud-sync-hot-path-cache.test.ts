import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppDependentJobIds } from "../src/gateway/services/cloudSync/resolveAppDependentJobs.js";
import {
  clearJsonFileCache,
  getFileDeriveCount,
  readDerivedFromFile,
} from "../src/gateway/services/cloudSync/jsonFileCache.js";
import {
  invalidateJobOwnerIndex,
  shouldAutoUploadJobFolder,
} from "../src/gateway/services/cloudUploadMode.js";
import { notifyJobOwnershipChanged } from "../src/gateway/services/cloudSync/jobOwnershipInvalidation.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearJsonFileCache();
  invalidateJobOwnerIndex();
});

function makeWorkspace(appCount: number, jobCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-hot-path-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });

  const jobs: Array<{ id: string; name: string; appIds: string[] }> = [];
  for (let i = 0; i < jobCount; i += 1) {
    const jobId = `job-${i}`;
    fs.mkdirSync(path.join(dir, "Jobs", jobId), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "Jobs", jobId, "job.json"),
      JSON.stringify({ id: jobId }),
    );
    jobs.push({ id: jobId, name: jobId, appIds: [`app-${i % appCount}`] });
  }
  fs.writeFileSync(
    path.join(dir, "data", "jobs.json"),
    JSON.stringify({ jobs }),
  );

  for (let i = 0; i < appCount; i += 1) {
    const appDir = path.join(dir, "apps", `app-${i}`);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "metadata.json"),
      JSON.stringify({ appId: `app-${i}`, title: `App ${i}` }),
    );
  }
  return dir;
}

/** Read + parse passes over the jobs index, the file that dominated the hot path. */
function jobsIndexReads(paprDir: string): number {
  return getFileDeriveCount(
    path.join(paprDir, "data", "jobs.json"),
    "jobsIndex",
  );
}

describe("readDerivedFromFile", () => {
  it("derives once while the file is unchanged and again after it changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-json-cache-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "value.json");
    fs.writeFileSync(filePath, JSON.stringify({ value: "first" }));

    let derives = 0;
    const read = (): string =>
      readDerivedFromFile(
        filePath,
        "test",
        (raw) => {
          derives += 1;
          return (JSON.parse(raw) as { value: string }).value;
        },
        "missing",
      );

    expect(read()).toBe("first");
    expect(read()).toBe("first");
    expect(read()).toBe("first");
    expect(derives).toBe(1);

    fs.writeFileSync(filePath, JSON.stringify({ value: "second" }));
    expect(read()).toBe("second");
    expect(derives).toBe(2);
  });

  it("returns the fallback for a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-json-cache-"));
    tempDirs.push(dir);
    expect(
      readDerivedFromFile(
        path.join(dir, "absent.json"),
        "test",
        () => "parsed",
        "fallback",
      ),
    ).toBe("fallback");
  });
});

describe("cloud sync hot path caching", () => {
  it("reads the jobs index once no matter how many apps are resolved", () => {
    const paprDir = makeWorkspace(40, 40);

    for (let i = 0; i < 40; i += 1) {
      resolveAppDependentJobIds(paprDir, `app-${i}`);
    }

    expect(jobsIndexReads(paprDir)).toBe(1);
  });

  it("re-reads the jobs index after it changes on disk", () => {
    const paprDir = makeWorkspace(2, 2);
    expect(resolveAppDependentJobIds(paprDir, "app-0")).toEqual(["job-0"]);

    fs.mkdirSync(path.join(paprDir, "Jobs", "job-new"), { recursive: true });
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-new", "job.json"),
      JSON.stringify({ id: "job-new" }),
    );
    fs.writeFileSync(
      path.join(paprDir, "data", "jobs.json"),
      JSON.stringify({
        jobs: [{ id: "job-new", name: "job-new", appIds: ["app-0"] }],
      }),
    );

    expect(resolveAppDependentJobIds(paprDir, "app-0")).toEqual(["job-new"]);
  });

  it("resolves job ownership without rescanning every app per job", () => {
    const paprDir = makeWorkspace(30, 30);

    for (let i = 0; i < 30; i += 1) {
      shouldAutoUploadJobFolder(`job-${i}`, paprDir);
    }

    expect(jobsIndexReads(paprDir)).toBe(1);
  });

  it("keeps ownership answers correct through the cached index", () => {
    const paprDir = makeWorkspace(2, 2);
    expect(shouldAutoUploadJobFolder("job-0", paprDir)).toBe(true);
    expect(shouldAutoUploadJobFolder("job-unknown", paprDir)).toBe(true);
  });

  it("rebuilds ownership immediately after notifyJobOwnershipChanged", () => {
    const paprDir = makeWorkspace(2, 1);
    fs.writeFileSync(
      path.join(paprDir, "data", "cloud-publish-prefs.json"),
      JSON.stringify({
        apps: {
          "app-0": { uploadMode: "manual", cloudEnabled: true, autoPublish: false, accessMode: "private" },
          "app-1": { uploadMode: "auto", cloudEnabled: true, autoPublish: false, accessMode: "private" },
        },
      }),
    );
    fs.writeFileSync(
      path.join(paprDir, "data", "jobs.json"),
      JSON.stringify({
        jobs: [{ id: "job-0", name: "job-0", appIds: ["app-0"] }],
      }),
    );

    expect(shouldAutoUploadJobFolder("job-0", paprDir)).toBe(false);

    fs.writeFileSync(
      path.join(paprDir, "data", "jobs.json"),
      JSON.stringify({
        jobs: [{ id: "job-0", name: "job-0", appIds: ["app-1"] }],
      }),
    );

    // Stale owner index still maps job-0 → app-0 (manual).
    expect(shouldAutoUploadJobFolder("job-0", paprDir)).toBe(false);

    notifyJobOwnershipChanged(paprDir);

    expect(shouldAutoUploadJobFolder("job-0", paprDir)).toBe(true);
  });
});
