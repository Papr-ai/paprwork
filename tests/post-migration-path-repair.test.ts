import { describe, expect, it } from "vitest";
import { normalizePortableJobPrompt } from "../src/gateway/services/jobs/normalizePortableJobPrompt.js";
import {
  containsRepairablePaprPaths,
  rewritePortablePaprPaths,
} from "../src/gateway/services/jobs/rewritePortablePaprPaths.js";
import { formatPostMigrationRepairSummary } from "../src/gateway/services/postMigrationPathRepair.js";

describe("rewritePortablePaprPaths", () => {
  const jobId = "8a323066-1111-2222-3333-444444444444";

  it("rewrites same-job absolute paths to $JOB_DIR and $JOB_DB", () => {
    const input =
      `python3 /Users/alice/Papr/Jobs/${jobId}/code/run.py ` +
      `--db /Users/alice/Papr/Jobs/${jobId}/data/data.db`;
    const { text, changed } = rewritePortablePaprPaths(input, jobId);
    expect(changed).toBe(true);
    expect(text).toContain("$JOB_DIR/code/run.py");
    expect(text).toContain("--db $JOB_DB");
    expect(text).not.toContain("/Users/alice/Papr");
  });

  it("rewrites other-job paths to $PAPR_HOME/Jobs/{id}", () => {
    const otherId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const input = `cat /Users/alice/Papr/Jobs/${otherId}/logs/run.log`;
    const { text } = rewritePortablePaprPaths(input, jobId);
    expect(text).toContain(`$PAPR_HOME/Jobs/${otherId}/logs/run.log`);
  });

  it("rewrites namespace-scoped job paths for the same job", () => {
    const input =
      "/Users/alice/Papr/orgs/org1/namespaces/ns1/Jobs/" +
      `${jobId}/code/main.py`;
    const { text } = rewritePortablePaprPaths(input, jobId);
    expect(text).toContain("$JOB_DIR/code/main.py");
  });

  it("returns unchanged when no repairable paths exist", () => {
    const input = "echo hello && python3 collector.py";
    const { text, changed } = rewritePortablePaprPaths(input, jobId);
    expect(changed).toBe(false);
    expect(text).toBe(input);
  });
});

describe("containsRepairablePaprPaths", () => {
  it("detects flat and absolute Papr paths", () => {
    expect(containsRepairablePaprPaths("~/Papr/Jobs/abc/code")).toBe(true);
    expect(containsRepairablePaprPaths("/Users/x/Papr/data/jobs.json")).toBe(
      true,
    );
    expect(
      containsRepairablePaprPaths(
        'DB="$HOME/Papr/jobs/a05fb03e-6c06-4875-ae50-7d4c1e7129de/data/data.db"',
      ),
    ).toBe(true);
    expect(containsRepairablePaprPaths("SELECT 1")).toBe(false);
  });
});

describe("normalizePortableJobPrompt", () => {
  it("rewrites $HOME Papr job paths to $PAPR_HOME/Jobs", () => {
    const normalized = normalizePortableJobPrompt(
      'DB="$HOME/Papr/jobs/job-id/data/data.db"',
    );
    expect(normalized).toBe('DB="$PAPR_HOME/Jobs/job-id/data/data.db"');
  });

  it("rewrites data and apps paths", () => {
    const normalized = normalizePortableJobPrompt(
      "sqlite3 ~/Papr/data/plans.db && ls ~/Papr/apps/foo",
    );
    expect(normalized).toContain("$PAPR_HOME/data/plans.db");
    expect(normalized).toContain("$PAPR_HOME/apps/foo");
  });

  it("collapses org/namespace prefix to $PAPR_HOME", () => {
    const normalized = normalizePortableJobPrompt(
      "/Users/x/Papr/orgs/orgA/namespaces/nsB/apps/my-app/index.html",
    );
    expect(normalized).toBe("$PAPR_HOME/apps/my-app/index.html");
  });
});

describe("formatPostMigrationRepairSummary", () => {
  it("includes counts from all phases", () => {
    const summary = formatPostMigrationRepairSummary({
      dryRun: true,
      dataSources: {
        scannedApps: 10,
        repairedApps: 2,
        repairCount: 3,
        repairs: [],
      },
      jobsJson: {
        scannedFiles: 1,
        repairedFiles: 1,
        repairedJobs: 2,
        repairs: [],
      },
      jobCode: { scannedFiles: 5, repairedFiles: 1, repairs: [] },
      appSource: { scannedFiles: 8, repairedFiles: 0, repairs: [] },
    });
    expect(summary).toContain("data-sources: 3");
    expect(summary).toContain("jobs.json: 2");
    expect(summary).toContain("job code: 1/5");
  });
});
