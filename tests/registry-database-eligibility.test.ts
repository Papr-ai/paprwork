import { describe, expect, it } from "vitest";
import {
  assertDataSourcesEligibleForRegistry,
  assertEligibleRegistryLocalPath,
  isEligibleRegistryLocalPath,
} from "../src/gateway/services/registryDatabaseEligibility.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";

describe("registryDatabaseEligibility", () => {
  const registryPath =
    "/Users/me/Papr/data/databases/seo-audit/data.db";
  const scratchPath =
    "/Users/me/Papr/Jobs/e540eab8-c84e-4c8e-92bb-9bf711fdf1ed/data/data.db";

  it("allows registry slug paths", () => {
    expect(isEligibleRegistryLocalPath(registryPath)).toBe(true);
    expect(() => assertEligibleRegistryLocalPath(registryPath)).not.toThrow();
  });

  it("rejects job scratch paths", () => {
    expect(isEligibleRegistryLocalPath(scratchPath)).toBe(false);
    expect(() => assertEligibleRegistryLocalPath(scratchPath)).toThrow(
      /Job scratch/,
    );
  });

  it("rejects scratch entries in data-sources validation", () => {
    const sources: AppDataSource[] = [
      {
        id: "bad",
        type: "sqlite",
        alias: "scratch",
        dbPath: scratchPath,
        tables: [],
        linkedAt: new Date().toISOString(),
      },
    ];
    expect(() => assertDataSourcesEligibleForRegistry(sources)).toThrow(
      /alias "scratch"/,
    );
  });
});
