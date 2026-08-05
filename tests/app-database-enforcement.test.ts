import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => {
  return {
    default: class MockDatabase {
      constructor(_path: string, _opts?: { readonly?: boolean }) {}
      prepare(_sql: string) {
        return {
          all: () => [{ name: "blog_picks" }],
        };
      }
      close() {}
    },
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import {
  appCodeUsesDatabaseApi,
  checkDbQueryWriteAntiPattern,
  checkMissingTablesOnPrimaryDb,
} from "../src/gateway/services/appDatabaseEnforcement.js";

describe("appCodeUsesDatabaseApi", () => {
  it("detects fetch calls to /api/db/*", () => {
    expect(
      appCodeUsesDatabaseApi(
        "await fetch('/api/db/query', { method: 'POST', body: '{}' });",
      ),
    ).toBe(true);
  });

  it("ignores bare endpoint mentions in docs or table cells", () => {
    expect(
      appCodeUsesDatabaseApi(
        `const rows = [["Renderer ↔ Gateway", "GET /api/db/query for reads"]];`,
      ),
    ).toBe(false);
  });

  it("ignores endpoint mentions in line comments", () => {
    expect(
      appCodeUsesDatabaseApi("// See /api/db/query for SELECT-only reads"),
    ).toBe(false);
  });
});

describe("checkDbQueryWriteAntiPattern", () => {
  it("errors when UPDATE is sent to /api/db/query", () => {
    const files = new Map<string, string>([
      [
        "settings.ts",
        `await fetch('/api/db/query', {
          method: 'POST',
          body: JSON.stringify({ appId, sql: 'UPDATE user_settings SET value = ? WHERE key = ?', params: ['x', 'y'] }),
        });`,
      ],
    ]);
    const issues = checkDbQueryWriteAntiPattern(files);
    expect(
      issues.some(
        (i) => i.rule === "db-query-write-forbidden" && i.severity === "error",
      ),
    ).toBe(true);
  });

  it("passes when mutations use /api/db/write", () => {
    const files = new Map<string, string>([
      [
        "settings.ts",
        `await fetch('/api/db/write', {
          method: 'POST',
          body: JSON.stringify({ appId, sql: 'UPDATE user_settings SET value = ?', params: ['x'] }),
        });`,
      ],
    ]);
    const issues = checkDbQueryWriteAntiPattern(files);
    expect(issues.filter((i) => i.rule === "db-query-write-forbidden")).toHaveLength(
      0,
    );
  });
});

describe("checkMissingTablesOnPrimaryDb", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      const { rm } = await import("fs/promises");
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("errors when SQL references a table missing from primary DB", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "papr-db-enforce-"));
    const dbPath = join(tempDir, "data.db");

    const files = new Map<string, string>([
      [
        "app.ts",
        `await fetch('/api/db/query', { method: 'POST', body: JSON.stringify({ appId, sql: 'SELECT * FROM user_settings' }) });`,
      ],
    ]);

    const issues = checkMissingTablesOnPrimaryDb(dbPath, files);
    expect(
      issues.some(
        (i) =>
          i.rule === "db-table-missing-on-primary" &&
          i.message.includes("user_settings"),
      ),
    ).toBe(true);
  });
});
