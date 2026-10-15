import { describe, expect, it } from "vitest";
import { blocksCommunityListing, communityOpen } from "../src/gateway/services/communityGalleryGate.js";
import { needsGallery, shareSteps, galleryApproved, galleryUsable } from "../ui/utils/galleryGate.js";
import type { AppAccess } from "../ui/utils/appRolesModel.js";

const access = (community: boolean, role: AppAccess["communityRole"] = community ? "contributor" : "none"): AppAccess => ({
  appId: "a", visibility: "private", linkPermission: "read", requireSignIn: false, publisherUserId: "pub", grants: [],
  workspaceRole: "none", linkRole: "none", communityRole: role, approvalRule: "contributors", derived: false,
  admins: ["pub"], callerRole: "admin", canManage: true, accessModel: "audiences",
  audiences: { workspace: false, link: false, community },
});

describe("gateway: Community listing needs a gallery", () => {
  it("blocks a save that newly opens Community without a gallery", () => {
    expect(blocksCommunityListing({ communityRole: "contributor" }, access(false), false)).toBe(true);
  });
  it("allows it once a gallery is approved", () => {
    expect(blocksCommunityListing({ communityRole: "contributor" }, access(false), true)).toBe(false);
  });
  it("leaves apps that are already listed alone, even changing role", () => {
    expect(blocksCommunityListing({ communityRole: "viewer" }, access(true), false)).toBe(false);
  });
  it("ignores saves that don't touch Community or turn it off", () => {
    expect(blocksCommunityListing({}, access(false), false)).toBe(false);
    expect(blocksCommunityListing({ communityRole: "none" }, access(true), false)).toBe(false);
  });
  it("reads older servers from the role when audiences are missing", () => {
    expect(communityOpen({ communityRole: "viewer" })).toBe(true);
    expect(communityOpen({ communityRole: "none" })).toBe(false);
    expect(communityOpen(null)).toBe(false);
  });
});

describe("Share sheet: the Gallery step", () => {
  it("is added only when this save newly lists in Community without an approved gallery", () => {
    expect(needsGallery(access(false), { community: "contributor" }, false)).toBe(true);
    expect(needsGallery(access(false), { community: "contributor" }, true)).toBe(false);
    expect(needsGallery(access(true), { community: "contributor" }, false)).toBe(false);
    expect(needsGallery(access(false), { community: "none" }, false)).toBe(false);
  });
  it("is the last step: 2 of 2 without keys, 3 of 3 with keys", () => {
    expect(shareSteps(false, true)).toEqual(["who", "gallery"]);
    expect(shareSteps(true, true)).toEqual(["who", "keys", "gallery"]);
    expect(shareSteps(true, false)).toEqual(["who", "keys"]);
    expect(shareSteps(false, false)).toEqual(["who"]);
  });
  it("approved = the video is the shared cover; usable = a finished video exists", () => {
    expect(galleryApproved({ sharedKind: "video" } as never)).toBe(true);
    expect(galleryApproved({ sharedKind: "image" } as never)).toBe(false);
    expect(galleryUsable({ exists: true, task: null } as never)).toBe(true);
    expect(galleryUsable({ exists: true, task: { state: "running" } } as never)).toBe(false);
    expect(galleryUsable(null)).toBe(false);
  });
});
