import { describe, expect, it } from "vitest";
import {
  dbIdFromPath,
  normalizeDbPath,
} from "../src/gateway/services/DatabaseRegistryService.js";
import {
  dbTursoDatabaseName,
  resolveTursoShortName,
} from "../src/gateway/services/tursoDatabaseNaming.js";
import { resolveDbEventTarget } from "../src/gateway/utils/resolveDbEventTarget.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";

describe("DatabaseRegistryService helpers", () => {
  it("dbIdFromPath is stable for normalized paths", () => {
    const a = dbIdFromPath("/tmp/foo/data.db");
    const b = dbIdFromPath("/tmp/foo/data.db");
    expect(a).toBe(b);
    expect(a).toMatch(/^db-[a-f0-9]{8}$/);
  });

  it("normalizeDbPath collapses duplicate separators", () => {
    expect(normalizeDbPath("/tmp//foo/data.db")).toBe("/tmp/foo/data.db");
  });
});

describe("tursoDatabaseNaming", () => {
  it("dbTursoDatabaseName uses d- prefix", () => {
    expect(dbTursoDatabaseName("db-abcdef12")).toBe("d-abcdef12");
  });

  it("resolveTursoShortName appends per-user suffix", () => {
    const name = resolveTursoShortName(
      { dbId: "db-abcdef12", isolation: "per-user" },
      "user-12345678-aaaa-bbbb-cccc-ddddeeeeffff",
    );
    expect(name).toBe("d-abcdef12-u-user1234");
  });
});

describe("resolveDbEventTarget", () => {
  const audit: AppDataSource = {
    id: "job-a:audit",
    type: "sqlite",
    jobId: "job-a-uuid",
    dbId: "db-aaaabbbb",
    alias: "audit",
    dbPath: "/tmp/audit.db",
    tables: [],
    linkedAt: "2026-01-01T00:00:00.000Z",
    role: "primary",
  };

  it("resolves alias to jobId and dbId", () => {
    const target = resolveDbEventTarget(
      { primary: "audit", sources: [audit] },
      "audit",
      "app-1",
    );
    expect(target.jobId).toBe("job-a-uuid");
    expect(target.dbId).toBe("db-aaaabbbb");
  });

  it("does not treat appId as jobId when sourceId missing", () => {
    const target = resolveDbEventTarget(
      { primary: "audit", sources: [audit] },
      undefined,
      "app-1",
    );
    expect(target.jobId).toBe("job-a-uuid");
    expect(target.dbId).toBe("db-aaaabbbb");
  });
});
