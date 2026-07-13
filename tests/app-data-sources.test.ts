import { describe, expect, test, vi } from "vitest";
import {
  getPrimarySource,
  inferPrimaryAlias,
  parseDataSourcesFile,
  resolveAppDataSource,
  serializeDataSourcesFile,
  type AppDataSource,
} from "../src/gateway/services/appDataSources.js";

const auditSource: AppDataSource = {
  id: "job-a:audit",
  type: "sqlite",
  jobId: "job-a",
  alias: "audit",
  dbPath: "/tmp/audit/data.db",
  tables: [],
  linkedAt: "2026-01-01T00:00:00.000Z",
  role: "primary",
};

const metricsSource: AppDataSource = {
  id: "job-b:metrics",
  type: "sqlite",
  jobId: "job-b",
  alias: "metrics",
  dbPath: "/tmp/metrics/data.db",
  tables: [],
  linkedAt: "2026-01-01T00:00:00.000Z",
  role: "readonly",
};

describe("appDataSources", () => {
  test("parses legacy array format with role primary", () => {
    const config = parseDataSourcesFile(
      JSON.stringify([auditSource, metricsSource]),
    );
    expect(config.sources).toHaveLength(2);
    expect(config.primary).toBe("audit");
  });

  test("legacy multi-source array without roles does not infer primary", () => {
    const config = parseDataSourcesFile(
      JSON.stringify([
        { ...auditSource, role: undefined },
        { ...metricsSource, role: undefined },
      ]),
    );
    expect(config.primary).toBeUndefined();
    expect(getPrimarySource(config)).toBeUndefined();
  });

  test("single legacy source infers primary", () => {
    const config = parseDataSourcesFile(
      JSON.stringify([{ ...auditSource, role: undefined }]),
    );
    expect(config.primary).toBe("audit");
  });

  test("parses object format with explicit primary", () => {
    const config = parseDataSourcesFile(
      JSON.stringify({ primary: "metrics", sources: [auditSource, metricsSource] }),
    );
    expect(config.primary).toBe("metrics");
    expect(getPrimarySource(config)?.alias).toBe("metrics");
  });

  test("serializes with primary field", () => {
    const raw = serializeDataSourcesFile({
      primary: "audit",
      sources: [auditSource],
    });
    const parsed = JSON.parse(raw) as { primary: string; sources: unknown[] };
    expect(parsed.primary).toBe("audit");
    expect(parsed.sources).toHaveLength(1);
  });

  test("defaults to primary source when sourceId omitted", async () => {
    const config = {
      primary: "audit",
      sources: [auditSource, metricsSource],
    };
    const resolved = await resolveAppDataSource(config, {
      sql: "SELECT * FROM report_evidence",
      operation: "read",
    });
    expect(resolved.alias).toBe("audit");
  });

  test("write to readonly source is rejected", async () => {
    const config = {
      primary: "audit",
      sources: [auditSource, metricsSource],
    };
    await expect(
      resolveAppDataSource(config, {
        sourceId: "metrics",
        operation: "write",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("falls back to secondary source on read when table missing on primary", async () => {
    const config = {
      primary: "audit",
      sources: [auditSource, metricsSource],
    };
    const tableExists = vi.fn(async (dbPath: string, table: string) => {
      return dbPath === metricsSource.dbPath && table === "csv_rows";
    });
    const resolved = await resolveAppDataSource(config, {
      sql: "SELECT * FROM csv_rows",
      operation: "read",
      tableExists,
    });
    expect(resolved.alias).toBe("metrics");
  });

  test("inferPrimaryAlias prefers role primary", () => {
    expect(
      inferPrimaryAlias([
        { ...metricsSource, role: undefined },
        auditSource,
      ]),
    ).toBe("audit");
  });
});
