import { beforeEach, describe, expect, it, vi } from "vitest";

const getPrimaryDataSource = vi.fn();
const initialize = vi.fn();

vi.mock("../src/gateway/services/AppService.js", () => ({
  getAppService: () => ({ initialize, getPrimaryDataSource }),
}));

import {
  requireJobAppDatabase,
  resolveJobAppDatabase,
} from "../src/gateway/services/jobAppDatabase.js";

describe("job app database resolution", () => {
  beforeEach(() => {
    initialize.mockReset();
    getPrimaryDataSource.mockReset();
  });

  it("returns null for standalone jobs", async () => {
    await expect(requireJobAppDatabase(["__standalone__"])).resolves.toBeNull();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("resolves a linked app primary database", async () => {
    getPrimaryDataSource.mockResolvedValue({
      dbPath: "/tmp/app/data.db",
      alias: "primary",
    });
    await expect(resolveJobAppDatabase(["app-123"])).resolves.toEqual({
      appId: "app-123",
      appDb: "/tmp/app/data.db",
      appDbAlias: "primary",
    });
  });

  it("fails fast when a linked app has no primary database", async () => {
    getPrimaryDataSource.mockResolvedValue(null);
    await expect(requireJobAppDatabase(["app-123"])).rejects.toThrow(
      /has no primary database/,
    );
  });
});
