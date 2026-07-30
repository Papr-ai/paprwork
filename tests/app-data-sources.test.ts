import { describe, expect, test } from "vitest";
import {
  getLegacyDefaultSource,
  getSingleLinkedSource,
  parseDataSourcesFile,
  resolveAppDataSource,
  resolveAttachAlias,
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
};

const metricsSource: AppDataSource = {
  id: "job-b:metrics",
  type: "sqlite",
  jobId: "job-b",
  alias: "metrics",
  dbPath: "/tmp/metrics/data.db",
  tables: [],
  linkedAt: "2026-01-01T00:00:00.000Z",
};

describe("appDataSources", () => {
  test("parses legacy array format", () => {
    const config = parseDataSourcesFile(
      JSON.stringify([auditSource, metricsSource]),
    );
    expect(config.sources).toHaveLength(2);
  });

  test("parses legacy primary field and resolves via getLegacyDefaultSource", () => {
    const config = parseDataSourcesFile(
      JSON.stringify({ primary: "metrics", sources: [auditSource, metricsSource] }),
    );
    expect(config.primary).toBe("metrics");
    expect(getSingleLinkedSource(config)).toBeUndefined();
    expect(getLegacyDefaultSource(config)?.alias).toBe("metrics");
  });

  test("serializes sources only (no primary field)", () => {
    const raw = serializeDataSourcesFile({
      sources: [auditSource],
    });
    const parsed = JSON.parse(raw) as {
      primary?: string;
      sources: Array<{ role?: string }>;
    };
    expect(parsed.primary).toBeUndefined();
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]?.role).toBeUndefined();
  });

  test("resolveAttachAlias avoids legacy primary default", () => {
    expect(
      resolveAttachAlias({
        registryLabel: "Blog Topic Planner DB",
        dbId: "db-bcfedc33",
      }),
    ).toBe("blog-topic-planner-db");
    expect(
      resolveAttachAlias({
        requested: "primary",
        registryLabel: "Blog Topic Planner DB",
        dbId: "db-bcfedc33",
      }),
    ).toBe("blog-topic-planner-db");
    expect(
      resolveAttachAlias({
        requested: "topics",
        registryLabel: "Blog Topic Planner DB",
        dbId: "db-bcfedc33",
      }),
    ).toBe("topics");
  });

  test("single linked source resolves without sourceId", async () => {
    const resolved = await resolveAppDataSource(
      { sources: [auditSource] },
      { operation: "read" },
    );
    expect(resolved.alias).toBe("audit");
  });

  test("multiple sources without legacy default require explicit sourceId", async () => {
    await expect(
      resolveAppDataSource(
        { sources: [auditSource, metricsSource] },
        { operation: "read" },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("legacy primary field resolves without sourceId", async () => {
    const resolved = await resolveAppDataSource(
      { primary: "metrics", sources: [auditSource, metricsSource] },
      { operation: "read" },
    );
    expect(resolved.alias).toBe("metrics");
  });

  test("legacy role primary resolves without sourceId", async () => {
    const resolved = await resolveAppDataSource(
      {
        sources: [
          auditSource,
          { ...metricsSource, role: "primary" },
        ],
      },
      { operation: "read" },
    );
    expect(resolved.alias).toBe("metrics");
  });

  test("resolves by explicit sourceId", async () => {
    const resolved = await resolveAppDataSource(
      { sources: [auditSource, metricsSource] },
      { sourceId: "metrics", operation: "write" },
    );
    expect(resolved.alias).toBe("metrics");
  });

  test("writes are allowed on any linked source", async () => {
    const resolved = await resolveAppDataSource(
      { sources: [auditSource, metricsSource] },
      { sourceId: "metrics", operation: "write" },
    );
    expect(resolved.alias).toBe("metrics");
  });
});
