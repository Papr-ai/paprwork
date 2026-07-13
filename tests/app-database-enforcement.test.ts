import { describe, expect, test } from "vitest";
import {
  appCodeUsesDatabaseApi,
  appFilesUseDatabaseApi,
  buildMissingDataSourceMessage,
} from "../src/gateway/services/appDatabaseEnforcement.js";

describe("appDatabaseEnforcement", () => {
  test("detects /api/db/query usage", () => {
    expect(
      appCodeUsesDatabaseApi(
        "await fetch('/api/db/query', { method: 'POST', body: JSON.stringify({ appId, sql }) })",
      ),
    ).toBe(true);
  });

  test("detects /api/db/write and /api/db/exec usage", () => {
    expect(appCodeUsesDatabaseApi("fetch('/api/db/write', opts)")).toBe(true);
    expect(appCodeUsesDatabaseApi("fetch('/api/db/exec', opts)")).toBe(true);
  });

  test("detects /api/db/schema usage", () => {
    expect(
      appCodeUsesDatabaseApi("fetch(`/api/db/schema?appId=${APP_ID}`)"),
    ).toBe(true);
  });

  test("detects db.ts helper imports", () => {
    expect(appCodeUsesDatabaseApi("import { queryRows } from './db';")).toBe(
      true,
    );
  });

  test("ignores apps without database API calls", () => {
    expect(appCodeUsesDatabaseApi("console.log('hello');")).toBe(false);
    expect(appCodeUsesDatabaseApi("fetch('/api/jobs/run')")).toBe(false);
  });

  test("appFilesUseDatabaseApi scans all files", () => {
    const files = new Map<string, string>([
      ["index.html", "<div>Hi</div>"],
      ["app.ts", "fetch('/api/db/query')"],
    ]);
    expect(appFilesUseDatabaseApi(files)).toBe(true);
  });

  test("buildMissingDataSourceMessage includes appId and fix steps", () => {
    const message = buildMissingDataSourceMessage("app-123");
    expect(message).toContain("app-123");
    expect(message).toContain("link_app_data_source");
    expect(message).toContain("appIds");
  });
});
