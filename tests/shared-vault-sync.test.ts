import { describe, expect, it } from "vitest";

import type { CustomKeyMetadata } from "../src/core/storage/CustomKeysStorage.js";
import {
  mapCloudVaultPermission,
  sharedMirrorKeyId,
  sharedNamesToPrune,
  shouldPushKeyToCloud,
} from "../src/core/storage/sharedVaultMirror.js";

describe("sharedVaultMirror helpers", () => {
  it("skips shared mirrors when pushing to cloud", () => {
    const shared: CustomKeyMetadata = {
      id: "shared-GOOGLEDRIVE",
      name: "GOOGLEDRIVE",
      permission: "always",
      clientAccess: "server",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scope: "org",
      orgScope: "organization",
      vaultAudience: "org",
      vaultOrigin: "shared",
      sharedShareScope: "org",
    };

    expect(shouldPushKeyToCloud(shared)).toBe(false);
    expect(shouldPushKeyToCloud({ ...shared, vaultOrigin: "local" })).toBe(true);
    expect(shouldPushKeyToCloud({ ...shared, vaultOrigin: undefined })).toBe(true);
  });

  it("builds stable shared mirror ids", () => {
    expect(sharedMirrorKeyId("GOOGLEDRIVE")).toBe("shared-GOOGLEDRIVE");
    expect(sharedMirrorKeyId("my-api-key")).toBe("shared-MY_API_KEY");
  });

  it("maps cloud permission labels", () => {
    expect(mapCloudVaultPermission("always_allow")).toBe("always");
    expect(mapCloudVaultPermission("ask")).toBe("ask");
    expect(mapCloudVaultPermission(undefined)).toBe("always");
  });

  it("prunes stale shared mirrors by name", () => {
    expect(
      sharedNamesToPrune(["GOOGLEDRIVE", "NEON_DB_URL"], ["GOOGLEDRIVE"]),
    ).toEqual(["NEON_DB_URL"]);
  });
});
