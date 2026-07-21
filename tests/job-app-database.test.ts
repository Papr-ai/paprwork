import { beforeEach, describe, expect, it, vi } from "vitest";

const getPrimaryDataSource = vi.fn();
const getApp = vi.fn();
const initialize = vi.fn();

vi.mock("../src/gateway/services/AppService.js", () => ({
  getAppService: () => ({ initialize, getPrimaryDataSource, getApp }),
}));

import {
  isLegacyApp,
  LEGACY_APP_PRIMARY_CUTOFF_ISO,
  requireJobAppDatabase,
  resolveJobAppDatabase,
} from "../src/gateway/services/jobAppDatabase.js";

describe("job app database resolution", () => {
  beforeEach(() => {
    initialize.mockReset();
    getPrimaryDataSource.mockReset();
    getApp.mockReset();
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

  it("fails fast when a new app has no primary database", async () => {
    getPrimaryDataSource.mockResolvedValue(null);
    getApp.mockResolvedValue({
      id: "app-new",
      title: "New App",
      createdAt: LEGACY_APP_PRIMARY_CUTOFF_ISO,
    });
    await expect(requireJobAppDatabase(["app-new"])).rejects.toThrow(
      /has no primary database/,
    );
  });

  it("allows legacy apps without primary to start without APP_DB", async () => {
    getPrimaryDataSource.mockResolvedValue(null);
    getApp.mockResolvedValue({
      id: "app-legacy",
      title: "Legacy App",
      createdAt: "2026-03-24T18:41:02.761Z",
    });
    await expect(requireJobAppDatabase(["app-legacy"])).resolves.toBeNull();
  });

  it("treats apps created before Jul 16 2026 as legacy", () => {
    expect(isLegacyApp("2026-07-15T23:59:59.999Z")).toBe(true);
    expect(isLegacyApp(LEGACY_APP_PRIMARY_CUTOFF_ISO)).toBe(false);
  });
});
