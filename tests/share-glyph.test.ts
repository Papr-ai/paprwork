import { describe, expect, it } from "vitest";
import {
  shareGlyphForCatalogEntry,
  shareGlyphForPublishState,
} from "../ui/utils/shareGlyph";
import type { CloudPublishState } from "../ui/utils/cloudPublishApi";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog";

const state = (over: Partial<CloudPublishState>): CloudPublishState => ({
  appId: "a",
  enabled: true,
  accessMode: "",
  shareUrl: "https://apps.papr.ai/x",
  slug: "x",
  publishedAt: null,
  ...over,
});

const entry = (
  over: Partial<CommunityCatalogEntry>,
): CommunityCatalogEntry => ({
  catalogId: "c",
  source: "cloud",
  name: "N",
  description: "",
  version: "1",
  author: "A",
  tags: [],
  codeInstallable: false,
  liveViewable: true,
  ...over,
});

describe("shareGlyphForPublishState", () => {
  it("is private when not published", () => {
    expect(shareGlyphForPublishState(null)).toEqual({
      audience: "private",
      codeAccess: "off",
    });
    expect(
      shareGlyphForPublishState(
        state({ shareUrl: null, loginAccess: "public" }),
      ).audience,
    ).toBe("private");
  });

  it("maps team, people, link and community like the share bar", () => {
    expect(
      shareGlyphForPublishState(state({ loginAccess: "team" })).audience,
    ).toBe("team");
    expect(
      shareGlyphForPublishState(
        state({ loginAccess: "team", prefs: { allowedEmails: ["a@b.co"] } }),
      ).audience,
    ).toBe("people");
    expect(
      shareGlyphForPublishState(
        state({ loginAccess: "none", externalLink: "read" }),
      ).audience,
    ).toBe("link");
    expect(
      shareGlyphForPublishState(
        state({ loginAccess: "public", prefs: { codeAccess: "install" } }),
      ),
    ).toEqual({ audience: "public", codeAccess: "install" });
  });
});

describe("shareGlyphForCatalogEntry", () => {
  it("reads visibility and code install", () => {
    expect(
      shareGlyphForCatalogEntry(
        entry({ visibility: "team", codeInstallable: true }),
      ),
    ).toEqual({
      audience: "team",
      codeAccess: "install",
    });
    expect(
      shareGlyphForCatalogEntry(entry({ visibility: "link_read" })).audience,
    ).toBe("link");
    expect(
      shareGlyphForCatalogEntry(entry({ visibility: "public_read" })).audience,
    ).toBe("public");
  });
});
