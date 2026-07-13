import { describe, expect, it } from "vitest";
import { shouldAppendShareToken } from "../src/core/utils/cloudShareLink.js";
import {
  accessModeToSharingSettings,
  sharingSettingsRequireShareToken,
  sharingSettingsToPublishFields,
  sharingSettingsToAccessMode,
} from "../src/gateway/services/cloudSharingSettings.js";

describe("cloudSharingSettings", () => {
  it("maps legacy access modes to login + external link axes", () => {
    expect(accessModeToSharingSettings("team")).toEqual({
      loginAccess: "team",
      externalLink: "off",
    });
    expect(accessModeToSharingSettings("link_read")).toEqual({
      loginAccess: "none",
      externalLink: "read",
    });
  });

  it("supports team login plus external read link", () => {
    const settings = { loginAccess: "team" as const, externalLink: "read" as const };
    expect(sharingSettingsToPublishFields(settings)).toEqual({
      visibility: "team",
      linkPermission: "read",
      shareLinkEnabled: true,
    });
    expect(sharingSettingsToAccessMode(settings)).toBe("team");
    expect(sharingSettingsRequireShareToken(settings)).toBe(true);
  });

  it("uses link-only visibility when Papr login is disabled", () => {
    expect(
      sharingSettingsToPublishFields({
        loginAccess: "none",
        externalLink: "read_write",
      }),
    ).toEqual({
      visibility: "link_read_write",
      linkPermission: "read_write",
      shareLinkEnabled: true,
    });
  });

  it("appends share token when external link is enabled", () => {
    expect(shouldAppendShareToken("team", true)).toBe(true);
    expect(shouldAppendShareToken("team", false)).toBe(false);
    expect(shouldAppendShareToken("link_read")).toBe(true);
  });
});
