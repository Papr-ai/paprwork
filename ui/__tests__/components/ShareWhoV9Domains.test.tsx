// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareWhoV9 } from "../../components/Apps/ShareWhoV9";

const grants = [{ domain: "leadedge.com", role: "contributor" }];
const access = {
  appId: "a", visibility: "public_read", linkPermission: "read", requireSignIn: false, publisherUserId: "pub",
  grants, workspaceRole: "none", linkRole: "none", communityRole: "viewer", approvalRule: "contributors",
  derived: false, admins: ["pub"], callerRole: "admin", canManage: true, accessModel: "audiences",
  audiences: { workspace: false, link: false, community: true },
} as const;
const draft = { workspace: "none", link: "none", community: "viewer", grants, requireSignIn: false } as const;

describe("ShareWhoV9 email domains", () => {
  it("lists an @domain with its own role next to Community", () => {
    const html = renderToStaticMarkup(
      <ShareWhoV9 access={access as never} draft={draft as never} onChange={vi.fn()} members={[]} />,
    );
    expect(html).toContain("@leadedge.com");
    expect(html).toContain("Anyone signed in with this email domain");
    expect(html).toContain("Contributor");
    expect(html).toContain("Listed in Community");
  });
});
