import { beforeEach, describe, expect, it } from "vitest";
import type { AppDataSourcesFile } from "../src/gateway/services/appDataSources.js";
import {
  coerceRequireSignInForPerUserIsolation,
  configHasPerUserLinkedSources,
  perUserIsolationRequiresCallerSignIn,
} from "../src/gateway/services/appRuntime/cloudAppPerUserAccess.js";
import {
  getDatabaseRegistryService,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../src/gateway/services/DatabaseRegistryService.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("cloudAppPerUserAccess", () => {
  useIsolatedPaprWorkspace("cloud-app-per-user-access");

  beforeEach(() => {
    resetDatabaseRegistryForWorkspaceSwitch();
  });

  it("coerceRequireSignInForPerUserIsolation forces sign-in when per-user enabled", () => {
    expect(coerceRequireSignInForPerUserIsolation(true, false)).toBe(true);
    expect(coerceRequireSignInForPerUserIsolation(true, undefined)).toBe(true);
    expect(coerceRequireSignInForPerUserIsolation(false, false)).toBe(false);
    expect(coerceRequireSignInForPerUserIsolation(undefined, true)).toBe(true);
  });

  it("configHasPerUserLinkedSources reads registry isolation", () => {
    const dbId = "db-abcdef12";
    getDatabaseRegistryService().mergeFromRegistryFile(
      JSON.stringify({
        version: 1,
        databases: {
          [dbId]: {
            dbId,
            localPath: "/tmp/data.db",
            tursoShortName: "d-abcdef12",
            isolation: "per-user",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const config = {
      primary: "main",
      sources: [
        {
          id: "db-1:main",
          type: "sqlite" as const,
          dbId,
          alias: "main",
          dbPath: "/tmp/data.db",
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
          role: "primary" as const,
        },
      ],
    } satisfies AppDataSourcesFile;

    expect(configHasPerUserLinkedSources(config)).toBe(true);
  });

  it("perUserIsolationRequiresCallerSignIn from prefs or registry", () => {
    expect(perUserIsolationRequiresCallerSignIn(true)).toBe(true);
    expect(perUserIsolationRequiresCallerSignIn(false)).toBe(false);
  });
});
