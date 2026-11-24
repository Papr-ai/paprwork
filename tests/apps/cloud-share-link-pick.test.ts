import { describe, expect, it } from "vitest";
import { pickShareLink } from "../../src/core/utils/cloudShareLink.js";

const URL_ = "https://papr-cloud-app-host-dev.example/CWO2OFMhZ9/grocery-list/";

describe("pickShareLink", () => {
  it("link sharing on → tokened link (grocery-list case)", () => {
    const p = pickShareLink(URL_, "tok123", { workspace: "none", link: "contributor", community: "none" });
    expect(p.shareLink).toBe(`${URL_}?t=tok123`);
    expect(p.shareLinkWho).toMatch(/Anyone with this exact link/);
  });

  it("link sharing on but no token → no link, says republish", () => {
    const p = pickShareLink(URL_, null, { link: "viewer" });
    expect(p.shareLink).toBeNull();
    expect(p.shareLinkWho).toMatch(/republish/);
  });

  it("community → plain url, notes sign-in when required", () => {
    expect(pickShareLink(URL_, "tok", { community: "viewer" }).shareLink).toBe(URL_);
    expect(pickShareLink(URL_, "tok", { community: "viewer", requireSignIn: true }).shareLinkWho).toMatch(/signing in/);
  });

  it("workspace / private → plain url (never leaks the token)", () => {
    expect(pickShareLink(`${URL_}?t=old`, "tok", { workspace: "viewer" })).toEqual({
      shareLink: URL_,
      shareLinkWho: "Workspace members, after signing in",
    });
    const priv = pickShareLink(URL_, "tok", { workspace: "none", link: "none", community: "none" });
    expect(priv.shareLink).toBe(URL_);
    expect(priv.shareLinkWho).toMatch(/Only you/);
  });

  it("not published → null", () => {
    expect(pickShareLink(null, "tok", { link: "viewer" }).shareLink).toBeNull();
  });
});
