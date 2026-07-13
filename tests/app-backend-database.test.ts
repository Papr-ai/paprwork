import { describe, expect, it } from "vitest";
import { resolveTursoDatabaseNameForSource } from "../src/gateway/services/DatabaseRegistryService.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import {
  getPrimarySource,
  type AppDataSourcesFile,
} from "../src/gateway/services/appDataSources.js";
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

describe("getPrimarySource dbId-only", () => {
  it("resolves primary without jobId", () => {
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
    const primary = getPrimarySource(config);
    expect(primary?.dbId).toBe("db-abcdef12");
    expect(primary?.jobId).toBeUndefined();
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
