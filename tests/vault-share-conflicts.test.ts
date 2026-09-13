import { describe, expect, it } from "vitest";

import { isSharedVaultAudience } from "../src/core/storage/customKeysVault.js";
import { mapCustomKeyMetadataToVaultEntry } from "../src/core/utils/cloudReposScope.js";

describe("vault share conflicts and members audience", () => {
  it("treats members as a shared vault audience", () => {
    expect(isSharedVaultAudience("members")).toBe(true);
    expect(isSharedVaultAudience("user")).toBe(false);
  });

  it("maps members audience with allowed user ids for cloud sync", () => {
    const entry = mapCustomKeyMetadataToVaultEntry({
      meta: {
        name: "NEON_DB_URL",
        permission: "ask",
        clientAccess: "server",
        vaultAudience: "members",
        vaultAudienceMemberIds: ["User-A", " user-b "],
      },
      value: "postgres://example",
      source: "manual",
    });

    expect(entry.shareScope).toBe("members");
    expect(entry.allowedUserIds).toEqual(["User-A", "user-b"]);
  });

  it("omits allowedUserIds when members audience has no selection", () => {
    const entry = mapCustomKeyMetadataToVaultEntry({
      meta: {
        name: "API_KEY",
        vaultAudience: "members",
      },
      value: "secret",
      source: "manual",
    });

    expect(entry.shareScope).toBe("members");
    expect(entry.allowedUserIds).toBeUndefined();
  });
});
