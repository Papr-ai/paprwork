import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { execSync } from "child_process";
import { AppService, resetAppServiceSingletonForTests } from "../src/gateway/services/AppService.js";
import { resetJobsServiceSingletonForTests } from "../src/gateway/services/JobsService.js";
import { getDataContractService } from "../src/gateway/services/DataContractService.js";

describe("DataContractService", () => {
  let originalHome: string | undefined;
  let originalPaprHome: string | undefined;
  let testHomeDir: string;
  let appService: AppService;

  beforeEach(async () => {
    resetAppServiceSingletonForTests();
    resetJobsServiceSingletonForTests();
    originalHome = process.env.HOME;
    originalPaprHome = process.env.PAPR_HOME;
    testHomeDir = path.join(
      os.tmpdir(),
      `paprwork-contract-svc-${Date.now()}`,
    );
    process.env.HOME = testHomeDir;
    // HOME alone is not enough: getPaprRoot() prefers ~/Papr/.active-workspace.json
    // (read from the REAL home) and re-syncs PAPR_HOME from it.
    process.env.PAPR_HOME = path.join(testHomeDir, "Papr");
    await fs.mkdir(path.join(testHomeDir, "Papr"), { recursive: true });
    appService = new AppService();
    await appService.initialize();
  });

  afterEach(async () => {
    appService.cleanup();
    resetAppServiceSingletonForTests();
    resetJobsServiceSingletonForTests();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPaprHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = originalPaprHome;
    }
    try {
      await fs.rm(testHomeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      execSync(`rm -rf "${testHomeDir}"`, { stdio: "pipe" });
    }
  });

  test("getDataHealth reports primary table counts and contract violations", async () => {
    const app = await appService.createApp("Health App", "Desc", [
      { filename: "index.html", content: "<h1>Health</h1>" },
    ]);

    const dbPath = path.join(testHomeDir, "audit.db");
    execSync(
      `sqlite3 "${dbPath}" "CREATE TABLE report_evidence (section_kind TEXT); INSERT INTO report_evidence VALUES ('bad_kind');"`,
      { stdio: "pipe" },
    );

    await appService.linkAppDataSource(app.id, {
      id: "job-1:audit",
      type: "sqlite",
      jobId: "job-1",
      alias: "audit",
      dbPath,
      tables: [],
      setPrimary: true,
    });

    const contractPath = getDataContractService().getContractPath(app.id);
    await fs.writeFile(
      contractPath,
      JSON.stringify(
        {
          version: 1,
          primarySource: "audit",
          tables: {
            report_evidence: {
              enums: {
                section_kind: ["findings", "overview"],
              },
              minRows: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const health = await getDataContractService().getDataHealth(app.id);
    expect(health.primary.alias).toBe("audit");
    expect(health.tableCounts.find((t) => t.table === "report_evidence")?.count).toBe(1);
    expect(health.contractValidation?.passed).toBe(false);
    expect(health.hasContract).toBe(true);
    expect(health.contractEnforcement).toBe("warn");
  });
});
