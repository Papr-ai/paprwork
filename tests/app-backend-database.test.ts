import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { resolveTursoDatabaseNameForSource } from "../src/gateway/services/DatabaseRegistryService.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import {
  getLegacyDefaultSource,
  type AppDataSourcesFile,
} from "../src/gateway/services/appDataSources.js";
import { resolveAppBackendDatabaseEnvFromConfig } from "../src/gateway/services/appRuntime/appBackendDatabase.js";
import {
  dbTursoDatabaseName,
  jobTursoDatabaseName,
} from "../src/gateway/services/tursoDatabaseNaming.js";

describe("resolveTursoDatabaseNameForSource", () => {
  it("falls back to jobTursoDatabaseName when registry empty", () => {
    const source: AppDataSource = {
      id: "j1:main",
      type: "sqlite",
      jobId: "de1a89d8-1234-5678-9abc-def012345678",
      alias: "main",
      dbPath: "/tmp/job.db",
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(resolveTursoDatabaseNameForSource(source)).toBe(
      jobTursoDatabaseName(source.jobId!),
    );
  });

  it("uses dbId prefix when only dbId set", () => {
    const source: AppDataSource = {
      id: "db-abc:crm",
      type: "sqlite",
      dbId: "db-abcdef12",
      alias: "crm",
      dbPath: "/tmp/crm.db",
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(resolveTursoDatabaseNameForSource(source)).toBe(
      dbTursoDatabaseName("db-abcdef12"),
    );
  });
});

describe("getLegacyDefaultSource dbId-only", () => {
  it("resolves default without jobId", () => {
    const config: AppDataSourcesFile = {
      primary: "crm",
      sources: [
        {
          id: "db-abc:crm",
          type: "sqlite",
          dbId: "db-abcdef12",
          alias: "crm",
          dbPath: "/tmp/crm.db",
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
          role: "primary",
        },
      ],
    };
    const primary = getLegacyDefaultSource(config);
    expect(primary?.dbId).toBe("db-abcdef12");
    expect(primary?.jobId).toBeUndefined();
  });
});

describe("resolveAppBackendDatabaseEnvFromConfig", () => {
  it("injects PAPR_DB_* for every linked source and APP_DB for active sourceId", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "papr-backend-env-"));
    const metricsPath = join(tempRoot, "metrics.db");
    const billingPath = join(tempRoot, "billing.db");
    await writeFile(metricsPath, "sqlite-placeholder");
    await writeFile(billingPath, "sqlite-placeholder");

    const config: AppDataSourcesFile = {
      sources: [
        {
          id: "db-a:metrics",
          type: "sqlite",
          dbId: "db-aaaa1111",
          alias: "metrics",
          dbPath: metricsPath,
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "db-b:billing",
          type: "sqlite",
          dbId: "db-bbbb2222",
          alias: "billing",
          dbPath: billingPath,
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const env = await resolveAppBackendDatabaseEnvFromConfig({
      appId: "app-1",
      config,
      sourceId: "billing",
    });

    expect(env.PAPR_DB_METRICS).toBe(metricsPath);
    expect(env.PAPR_DB_BILLING).toBe(billingPath);
    expect(env.PAPR_DB_METRICS_ALIAS).toBe("metrics");
    expect(env.PAPR_DB_BILLING_ALIAS).toBe("billing");
    expect(env.APP_DB).toBe(billingPath);
    expect(env.PAPR_ACTIVE_SOURCE_ID).toBe("billing");
    expect(env.PAPR_LINKED_DB_ALIASES).toBe("metrics,billing");
  });
});

describe("TS/Python Turso naming parity", () => {
  it("matches memory job_turso_short_name for sample job", () => {
    const jobId = "de1a89d8-1234-5678-9abc-def012345678";
    expect(jobTursoDatabaseName(jobId)).toBe("j-de1a89d8");
  });

  it("matches memory db_turso_short_name for sample dbId", () => {
    expect(dbTursoDatabaseName("db-abcdef12")).toBe("d-abcdef12");
  });
});
