import { describe, expect, test } from "vitest";
import {
  resolveMigrationRootFromDbPath,
  resolvePersistedDatabaseLayout,
} from "../src/gateway/services/jobs/databaseMigrations.js";

describe("databaseMigrations", () => {
  test("resolves registry and job migration roots", () => {
    expect(
      resolveMigrationRootFromDbPath(
        "/Users/test/Papr/data/databases/gtm-audit/data.db",
      ),
    ).toBe("/Users/test/Papr/data/databases/gtm-audit");

    expect(
      resolveMigrationRootFromDbPath(
        "/Users/test/Papr/Jobs/job-1/data/data.db",
      ),
    ).toBe("/Users/test/Papr/Jobs/job-1");

    expect(resolveMigrationRootFromDbPath("/tmp/foo.db")).toBeNull();
  });

  test("classifies registry vs job layout", () => {
    const registry = resolvePersistedDatabaseLayout(
      "/Users/test/Papr/data/databases/billing/data.db",
    );
    expect(registry?.kind).toBe("registry");

    const job = resolvePersistedDatabaseLayout(
      "/Users/test/Papr/Jobs/job-1/data/data.db",
    );
    expect(job?.kind).toBe("job");
  });
});
