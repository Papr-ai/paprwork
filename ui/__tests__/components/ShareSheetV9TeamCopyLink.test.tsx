// @vitest-environment jsdom
/**
 * Team copy (on the team's data) Share sheet: Contributors, Maintainers and
 * Admins always see the original's link + Copy link; Admins also see API keys.
 * Viewers see who has access only.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Node 25's built-in localStorage has no getItem without --localstorage-file.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
});

vi.mock("../../components/Apps/ShareSheetBody", async (orig) => ({
  ...(await orig<typeof import("../../components/Apps/ShareSheetBody")>()),
  useKeySpecs: () => [{ name: "OPENAI_API_KEY", provider: "owner", required: true }],
}));
vi.mock("../../components/Apps/ShareDataCheck", () => ({ ShareDataCheck: () => null }));
vi.mock("../../utils/appDemo", () => ({
  useDemoStatus: () => null,
  shareDemoVideo: vi.fn(),
  startDemoGeneration: vi.fn(),
}));

import { ShareSheetV9 } from "../../components/Apps/ShareSheetV9";

const URL = "https://apps.papr.ai/ns-1/crm";

function access(callerRole: string, canManage: boolean) {
  return {
    appId: "src-app", visibility: "team", linkPermission: "read", requireSignIn: false, publisherUserId: "pub",
    grants: [], workspaceRole: "contributor", linkRole: "none", communityRole: "none", approvalRule: "contributors",
    derived: false, admins: ["pub"], callerRole, canManage, accessModel: "audiences",
    audiences: { workspace: true, link: false, community: false },
  };
}

function render(callerRole: string, canManage: boolean, hideLink = true): string {
  const body = {
    appId: "copy-app", linkUrl: URL, onCopyLink: vi.fn(), onOpenLink: vi.fn(),
    missingKeys: [], busy: false, access: { members: [] },
  };
  return renderToStaticMarkup(
    <ShareSheetV9 body={body as never} access={access(callerRole, canManage) as never}
      onAccessSaved={vi.fn()} hideLink={hideLink} />,
  );
}

describe("ShareSheetV9 — team copy link by role", () => {
  it("Admin sees the link, Copy link and API keys", () => {
    const html = render("admin", true);
    expect(html).toContain(URL);
    expect(html).toContain("Copy link");
    expect(html).toContain("API keys");
  });

  it("Maintainer sees the link and Copy link (no API keys)", () => {
    const html = render("maintainer", false);
    expect(html).toContain("Copy link");
    expect(html).not.toContain("API keys");
  });

  it("Contributor sees the link and Copy link", () => {
    expect(render("contributor", false)).toContain("Copy link");
  });

  it("Viewer sees who has access only", () => {
    expect(render("viewer", false)).not.toContain("Copy link");
  });

  it("owner's own app is unchanged: link + API keys", () => {
    const html = render("admin", true, false);
    expect(html).toContain("Copy link");
    expect(html).toContain("API keys");
  });
});
