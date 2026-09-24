import { describe, expect, it } from "vitest";
import {
  audienceModelToPublishPrefs,
  audienceModelToSharing,
  isCodePermission,
  isPermissionAvailable,
  isUserAllowedByAudienceModel,
  isWebLinkPermission,
  liveLinkPermissionForAudienceModel,
  permissionAffectsCloud,
  permissionToCodeAccess,
  publishPrefsToAudienceModel,
  sharingToAudienceModel,
  shouldListInCommunity,
} from "../src/core/utils/shareAudienceModel";

describe("shareAudienceModel", () => {
  it("maps link read/write", () => {
    expect(sharingToAudienceModel("none", "read")).toEqual({
      audience: "link",
      permission: "read",
      requireSignIn: false,
    });
    expect(sharingToAudienceModel("none", "read_write")).toEqual({
      audience: "link",
      permission: "write",
      requireSignIn: false,
    });
    expect(sharingToAudienceModel("public", "read")).toEqual({
      audience: "link",
      permission: "read",
      requireSignIn: true,
    });
  });

  it("round-trips public and team", () => {
    const publicModel = sharingToAudienceModel("public", "off");
    expect(publicModel).toEqual({
      audience: "public",
      permission: "write",
      requireSignIn: false,
    });
    expect(audienceModelToSharing(publicModel)).toEqual({
      loginAccess: "public",
      externalLink: "off",
    });
    expect(liveLinkPermissionForAudienceModel(publicModel)).toBe("read_write");

    const teamModel = sharingToAudienceModel("team", "off");
    expect(teamModel).toEqual({ audience: "team", permission: "write" });
    expect(audienceModelToSharing(teamModel)).toEqual({
      loginAccess: "team",
      externalLink: "off",
    });
    expect(liveLinkPermissionForAudienceModel(teamModel)).toBe("read_write");
  });

  it("maps code access to edit permission", () => {
    expect(
      sharingToAudienceModel("public", "off", "install"),
    ).toEqual({
      audience: "public",
      permission: "edit",
      requireSignIn: false,
    });
    expect(
      sharingToAudienceModel("team", "off", "install"),
    ).toEqual({
      audience: "team",
      permission: "edit",
    });
    expect(permissionToCodeAccess("edit")).toBe("install");
    expect(isCodePermission("edit")).toBe(true);
  });

  it("edit permission maps to live ACL by audience", () => {
    expect(
      audienceModelToSharing({ audience: "public", permission: "edit" }),
    ).toEqual({ loginAccess: "public", externalLink: "off" });
    expect(
      audienceModelToSharing({ audience: "team", permission: "edit" }),
    ).toEqual({ loginAccess: "team", externalLink: "off" });
    expect(
      audienceModelToSharing({ audience: "link", permission: "edit" }),
    ).toEqual({ loginAccess: "public", externalLink: "read_write" });
    expect(
      audienceModelToSharing({
        audience: "link",
        permission: "edit",
        requireSignIn: false,
      }),
    ).toEqual({ loginAccess: "none", externalLink: "read_write" });
  });

  it("edit does not affect cloud ACL when private", () => {
    expect(
      permissionAffectsCloud({ audience: "private", permission: "edit" }),
    ).toBe(false);
  });

  it("gates permissions by audience", () => {
    expect(isPermissionAvailable("link", "write")).toBe(true);
    expect(isPermissionAvailable("team", "edit")).toBe(true);
    expect(isPermissionAvailable("public", "write")).toBe(true);
    expect(isPermissionAvailable("public", "edit")).toBe(true);
    expect(isPermissionAvailable("private", "edit")).toBe(false);
  });

  it("identifies web link permissions", () => {
    expect(isWebLinkPermission("read")).toBe(true);
    expect(isWebLinkPermission("edit")).toBe(false);
  });

  it("builds publish prefs with code access", () => {
    expect(
      audienceModelToPublishPrefs({ audience: "public", permission: "edit" }),
    ).toEqual({
      sharing: { loginAccess: "public", externalLink: "off" },
      codeAccess: "install",
    });
  });

  it("lists public published apps in community", () => {
    expect(shouldListInCommunity("public", true)).toBe(true);
    expect(shouldListInCommunity("team", true)).toBe(false);
    expect(shouldListInCommunity("public", false)).toBe(false);
  });

  it("publishes people + external email as public with sign-in", () => {
    expect(
      audienceModelToSharing({
        audience: "people",
        permission: "write",
        allowedEmails: ["guest@acme.com"],
      }),
    ).toEqual({ loginAccess: "public", externalLink: "off" });
  });

  it("allows guest by email or domain on people audience", () => {
    const model = {
      audience: "people" as const,
      allowedEmails: ["guest@acme.com"],
      allowedEmailDomains: ["partner.io"],
    };
    expect(
      isUserAllowedByAudienceModel(model, undefined, "pub", "guest@acme.com"),
    ).toBe(true);
    expect(
      isUserAllowedByAudienceModel(model, undefined, "pub", "x@partner.io"),
    ).toBe(true);
    expect(
      isUserAllowedByAudienceModel(model, undefined, "pub", "other@evil.com"),
    ).toBe(false);
  });

  it("round-trips public prefs with email allowlist to people audience", () => {
    const model = publishPrefsToAudienceModel("public", "off", "off", {
      requireSignIn: true,
      allowedEmails: ["guest@acme.com"],
    });
    expect(model.audience).toBe("people");
    expect(model.allowedEmails).toEqual(["guest@acme.com"]);
    expect(model.requireSignIn).toBe(true);
  });

  it("maps public community sign-in requirement", () => {
    expect(
      sharingToAudienceModel("public", "off", "off", { requireSignIn: true }),
    ).toEqual({
      audience: "public",
      permission: "write",
      requireSignIn: true,
    });
    expect(
      sharingToAudienceModel("public", "off", "off", { requireSignIn: false }),
    ).toEqual({
      audience: "public",
      permission: "write",
      requireSignIn: false,
    });
  });
});
