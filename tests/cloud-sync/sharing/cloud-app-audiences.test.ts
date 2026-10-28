import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/utils/cloudApiClient.js", () => ({ cloudApiFetch: vi.fn() }));
vi.mock("../../../src/gateway/services/CloudAppLineageService.js", () => ({ getCloudAppLineageService: () => ({ readLineageForApp: async () => null }) }));
vi.mock("../../../src/gateway/services/cloudPublishPrefs.js", () => ({ getAppPublishPrefs: () => ({}), setAppPublishPrefs: vi.fn() }));

import { audiencesPatchFromSharing, describeAudiences } from "../../../src/gateway/services/cloudAppAudiences.js";

const v9 = { accessModel: "audiences", audiences: { workspace: true, link: false, community: false }, workspaceRole: "viewer", linkRole: "none", communityRole: "none" } as const;

describe("audiencesPatchFromSharing", () => {
  it("adds the audiences marker on a legacy app", () => {
    expect(audiencesPatchFromSharing({ loginAccess: "team" }, null)).toMatchObject({ accessModel: "audiences", workspaceRole: "viewer", communityRole: "none" });
  });
  it("workspace + invite link (read_write) = Anyone with the link: Contributor, Community off", () => {
    expect(audiencesPatchFromSharing({ loginAccess: "team", externalLink: "read_write" }, { ...v9 })).toEqual({ workspaceRole: "viewer", linkRole: "contributor", communityRole: "none" });
  });
  it("public lists in Community and turns the link row off", () => {
    expect(audiencesPatchFromSharing({ loginAccess: "public", requireSignIn: false }, { ...v9 })).toEqual({ communityRole: "viewer", linkRole: "none", requireSignIn: false });
  });
  it("keeps an existing workspace role", () => {
    expect(audiencesPatchFromSharing({ loginAccess: "team" }, { ...v9, workspaceRole: "contributor" }).workspaceRole).toBe("contributor");
  });
  it("private closes workspace and Community", () => {
    expect(audiencesPatchFromSharing({ loginAccess: "private" }, { ...v9 })).toEqual({ workspaceRole: "none", communityRole: "none" });
  });
  it("describes only open audiences", () => {
    expect(describeAudiences({ ...v9, linkRole: "viewer" })).toEqual({ workspace: "viewer", link: "none", community: "none", requireSignIn: false });
  });
});

describe("audiencesAccessMode follows the link role, not the lagging linkPermission", () => {
  it("viewer link is link_read even when the server still says read_write", async () => {
    const { audiencesAccessMode } = await import("../../../src/gateway/services/cloudAppAudiences.js");
    const a = { accessModel: "audiences", visibility: "link_read_write", linkPermission: "read_write",
      audiences: { workspace: true, link: true, community: false }, workspaceRole: "viewer", linkRole: "viewer" } as const;
    expect(audiencesAccessMode(a as never)).toBe("link_read");
    expect(audiencesAccessMode({ ...a, linkRole: "contributor" } as never)).toBe("link_read_write");
    expect(audiencesAccessMode({ ...a, audiences: { workspace: true, link: false, community: false } } as never)).toBe("team");
  });
});
