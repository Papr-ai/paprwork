import { describe, expect, it } from "vitest";
import {
  collectBackendManifestKeyNames,
  parseAppBackendManifest,
} from "../src/gateway/services/appRuntime/appBackendManifest.js";
import {
  filterVaultKeyNames,
  isPlatformInjectedEnvKey,
} from "../src/core/utils/platformInjectedEnvKeys.js";
import {
  mergeBackendKeysIntoRequirements,
  parseRequirementsFileContent,
} from "../src/gateway/services/cloudAppRequirements.js";

describe("platformInjectedEnvKeys", () => {
  it("detects PAPR_CALLER identity env vars", () => {
    expect(isPlatformInjectedEnvKey("PAPR_CALLER_USER_ID")).toBe(true);
    expect(isPlatformInjectedEnvKey("PAPR_CALLER_EMAIL")).toBe(true);
    expect(isPlatformInjectedEnvKey("PAPR_CALLER_FOO")).toBe(true);
    expect(isPlatformInjectedEnvKey("PAPR_API_KEY")).toBe(false);
    expect(isPlatformInjectedEnvKey("NEON_DB_URL")).toBe(false);
  });

  it("filters platform keys from vault key lists", () => {
    expect(
      filterVaultKeyNames([
        "PAPR_CALLER_USER_ID",
        "PAPR_CALLER_EMAIL",
        "PAPR_API_KEY",
      ]),
    ).toEqual(["PAPR_API_KEY"]);
  });
});

describe("cloudAppRequirements PAPR_CALLER guard", () => {
  it("does not merge PAPR_CALLER keys into requirements", () => {
    const merged = mergeBackendKeysIntoRequirements([], [
      "PAPR_CALLER_USER_ID",
      "PAPR_CALLER_EMAIL",
      "NEON_DB_URL",
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe("NEON_DB_URL");
  });

  it("strips PAPR_CALLER from parsed requirements.json content", () => {
    const parsed = parseRequirementsFileContent(
      JSON.stringify({
        schemaVersion: "1.0.0",
        requirements: [
          {
            name: "PAPR_CALLER_USER_ID",
            service: "Caller",
            category: "other",
            description: "should drop",
            required: true,
            credentialScope: "owner",
          },
          {
            name: "PAPR_API_KEY",
            service: "Papr",
            category: "ai",
            description: "keep",
            required: true,
            credentialScope: "owner",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(parsed.map((spec) => spec.name)).toEqual(["PAPR_API_KEY"]);
  });

  it("collectBackendManifestKeyNames excludes PAPR_CALLER keys", () => {
    const manifest = parseAppBackendManifest({
      version: 1,
      actions: {
        ping: {
          handler: "ping.py",
          runtime: "python",
          keys: ["PAPR_CALLER_USER_ID", "PAPR_CALLER_EMAIL", "PAPR_API_KEY"],
        },
      },
    });
    expect(collectBackendManifestKeyNames(manifest)).toEqual(["PAPR_API_KEY"]);
  });
});
