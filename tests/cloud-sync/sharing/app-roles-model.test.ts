import { describe, expect, it } from "vitest";
import {
  accessPatch,
  addGrant,
  editableGrants,
  grantKey,
  removeGrant,
  roleOptions,
  setGrantRole,
  summarizeAccess,
  type AppAccess,
} from "../../../ui/utils/appRolesModel.js";

const base: AppAccess = {
  appId: "a",
  visibility: "team",
  linkPermission: "read",
  requireSignIn: false,
  publisherUserId: "pub",
  grants: [],
  workspaceRole: "contributor",
  linkRole: "none",
  communityRole: "none",
  approvalRule: "contributors",
  derived: true,
  admins: ["pub"],
  callerRole: "admin",
  canManage: true,
};

describe("appRolesModel", () => {
  it("caps each audience like the server", () => {
    expect(roleOptions("workspace")).toEqual(["none", "viewer", "contributor", "maintainer"]);
    expect(roleOptions("link")).toEqual(["none", "viewer", "contributor"]);
    expect(roleOptions("community")).toEqual(["none", "viewer", "contributor"]);
    expect(roleOptions("person")).toEqual(["viewer", "contributor", "maintainer", "admin"]);
  });

  it("adds people once, edits and removes by id or email", () => {
    let g = addGrant([], { userId: "u1" });
    g = addGrant(g, { userId: "u1" });
    g = addGrant(g, { email: "Sam@X.com" }, "viewer");
    expect(g).toEqual([{ userId: "u1", role: "contributor" }, { email: "sam@x.com", role: "viewer" }]);
    g = setGrantRole(g, "u1", "maintainer");
    expect(g[0].role).toBe("maintainer");
    expect(removeGrant(g, "sam@x.com")).toHaveLength(1);
  });

  it("hides the publisher from editable grants", () => {
    const a = { ...base, grants: [{ userId: "pub", role: "admin" as const }, { userId: "u", role: "viewer" as const }] };
    expect(editableGrants(a)).toEqual([{ userId: "u", role: "viewer" }]);
  });

  it("patches only what changed", () => {
    expect(accessPatch(base, base)).toEqual({});
    const draft = { ...base, workspaceRole: "maintainer" as const, grants: [{ userId: "u", role: "admin" as const }] };
    expect(accessPatch(base, draft)).toEqual({ workspaceRole: "maintainer", grants: draft.grants });
    const reordered = { ...draft, grants: [...draft.grants] };
    expect(accessPatch(draft, reordered)).toEqual({});
  });

  it("sends the upload cap only when it changed", () => {
    const live = { ...base, uploadMaxMb: 50 };
    expect(accessPatch(live, { ...live })).toEqual({});
    expect(accessPatch(live, { ...live, uploadMaxMb: 500 })).toEqual({ uploadMaxMb: 500 });
  });

  it("summarizes like the plan", () => {
    const a = { ...base, grants: [{ userId: "u", role: "maintainer" as const }, { email: "s@x.com", role: "viewer" as const }] };
    expect(summarizeAccess(a)).toBe("Workspace: Contributor · 2 people");
    expect(summarizeAccess({ ...base, visibility: "link_read", linkRole: "viewer" })).toBe("Link: Viewer");
    expect(summarizeAccess({ ...base, workspaceRole: "none" })).toBe("Only Admins");
  });
});

import {
  audiencesDirty,
  audiencesPatch,
  draftFromAccess,
  summarizeAudiences,
  widestAudience,
} from "../../../ui/utils/shareAudiencesModel";

describe("v9 audiences", () => {
  const base = {
    appId: "a", visibility: "team", linkPermission: "read", requireSignIn: false,
    publisherUserId: "pub", grants: [{ userId: "pub", role: "admin" }], workspaceRole: "contributor",
    linkRole: "none", communityRole: "viewer", approvalRule: "contributors", derived: false,
    admins: ["pub"], callerRole: "admin", canManage: true,
    audiences: { workspace: true, link: false, community: false },
  } as const;

  it("shows only audiences open today (leftover Community role stays off)", () => {
    const d = draftFromAccess(base as never);
    expect(d.workspace).toBe("contributor");
    expect(d.community).toBe("none");
    expect(summarizeAudiences(d, "pub")).toBe("Workspace: Contributor");
    expect(widestAudience(d, "pub")).toBe("team");
  });

  it("first save sends everything with the marker; later only changes", () => {
    const d = { ...draftFromAccess(base as never), link: "viewer" as const };
    expect(audiencesDirty(base as never, d)).toBe(true);
    const first = audiencesPatch(base as never, d);
    expect(first).toMatchObject({ accessModel: "audiences", workspaceRole: "contributor", linkRole: "viewer", communityRole: "none" });
    const v9 = { ...base, accessModel: "audiences" } as never;
    expect(audiencesPatch(v9, d)).toEqual({ linkRole: "viewer" });
    expect(audiencesDirty(base as never, draftFromAccess(base as never))).toBe(false);
  });

  it("an email domain is a grant with its own role (capped at Maintainer)", () => {
    const v9 = { ...base, accessModel: "audiences" } as never;
    const d = draftFromAccess(v9);
    const grants = addGrant(d.grants, { domain: "@LeadEdge.com" }, "viewer");
    expect(grants.at(-1)).toEqual({ domain: "leadedge.com", role: "viewer" });
    expect(grantKey(grants.at(-1)!)).toBe("@leadedge.com");
    const up = setGrantRole(grants, "@leadedge.com", "contributor");
    expect(audiencesPatch(v9, { ...d, grants: up })).toEqual({ grants: up });
    expect(summarizeAudiences({ ...d, grants: up }, "pub")).toBe("Workspace: Contributor · 1 person");
    expect(roleOptions("domain")).toEqual(["viewer", "contributor", "maintainer"]);
    expect(addGrant(grants, { domain: "leadedge.com" })).toBe(grants);
  });
});

describe("Public access row (link or Community)", () => {
  it("one role follows the row between link and Community", async () => {
    const { publicMode, publicRole, setPublicMode, setPublicRole } = await import("../../../ui/utils/shareAudiencesModel.js");
    const base = { workspace: "none", link: "none", community: "none", grants: [], requireSignIn: false } as const;
    let d = setPublicMode({ ...base }, "link");
    expect([publicMode(d), publicRole(d)]).toEqual(["link", "viewer"]);
    d = setPublicMode(d, "community");
    expect([d.link, d.community, publicRole(d)]).toEqual(["none", "viewer", "viewer"]);
    d = setPublicRole(d, "contributor");
    expect(d.community).toBe("contributor");
    d = setPublicMode(d, "link");
    expect([d.link, d.community]).toEqual(["contributor", "none"]);
    d = setPublicMode(d, "off");
    expect(publicMode(d)).toBe("off");
  });
});
