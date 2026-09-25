import { describe, expect, it } from "vitest";
import {
  resolvePublishFieldsFromMemory,
  resolvePublishFieldsWhenPreservingCloudSharing,
} from "../src/gateway/services/cloudPublishMapping.js";

describe("resolvePublishFieldsWhenPreservingCloudSharing", () => {
  it("keeps memory visibility but uses prefs for community listing", () => {
    const memory = {
      enabled: true,
      visibility: "public_read",
      linkPermission: "read_write",
      requireSignIn: true,
      codeAccess: "off" as const,
    };
    const prefs = {
      autoPublish: false,
      accessMode: "public_read" as const,
      loginAccess: "public" as const,
      externalLink: "off" as const,
      codeAccess: "off" as const,
      requireSignIn: true,
      allowedEmails: ["guest@acme.com"],
    };

    const preserved = resolvePublishFieldsWhenPreservingCloudSharing(memory, prefs);
    const fromMemory = resolvePublishFieldsFromMemory(memory);

    expect(preserved.visibility).toBe(fromMemory.visibility);
    expect(preserved.communityCatalogListed).toBe(false);
    expect(fromMemory.communityCatalogListed).toBe(true);
  });

  it("preserves workspace people apps as team + not community listed", () => {
    const memory = {
      enabled: true,
      visibility: "team",
      linkPermission: "read_write",
      codeAccess: "off" as const,
    };
    const prefs = {
      autoPublish: false,
      accessMode: "team" as const,
      loginAccess: "team" as const,
      externalLink: "off" as const,
      codeAccess: "off" as const,
      allowedUserIds: ["user-a"],
    };

    const preserved = resolvePublishFieldsWhenPreservingCloudSharing(memory, prefs);
    expect(preserved.visibility).toBe("team");
    expect(preserved.communityCatalogListed).toBe(false);
  });
});
