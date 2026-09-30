import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockDiscoverTursoLinkedSources = vi.fn();

vi.mock("../src/gateway/services/tursoLinkedSources.js", () => ({
  discoverTursoLinkedSources: (...args: unknown[]) =>
    mockDiscoverTursoLinkedSources(...args),
}));

vi.mock("../src/gateway/services/jobs/databaseMigrations.js", () => ({
  applyDatabaseMigrations: vi.fn(),
  resolveMigrationRootFromDbPath: vi.fn(),
}));

import { applyLocalMigrationsForApp } from "../src/gateway/services/cloudSync/applyLocalMigrationsForApp.js";

describe("applyLocalMigrationsForApp", () => {
  beforeEach(() => {
    mockDiscoverTursoLinkedSources.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("skips direct SQLite migrations when cloud sync is enabled", async () => {
    vi.stubEnv("CLOUD_SYNC_ENABLED", "true");

    const applied = await applyLocalMigrationsForApp("app-1", "/tmp/apps");

    expect(applied).toEqual([]);
    expect(mockDiscoverTursoLinkedSources).not.toHaveBeenCalled();
  });
});
