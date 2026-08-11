import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import {
  isCommunityCatalogListed,
  shouldIncludeInPublicCommunity,
} from "../src/gateway/services/CommunityCatalogService.js";

const getAppPublishPrefs = vi.fn();

vi.mock("../src/gateway/services/cloudPublishPrefs.js", () => ({
  getAppPublishPrefs: (...args: unknown[]) => getAppPublishPrefs(...args),
}));

function cloudEntry(
  overrides: Partial<CommunityCatalogEntry> = {},
): CommunityCatalogEntry {
  return {
    catalogId: "cloud:app-1",
    source: "cloud",
    name: "Shared App",
    description: "",
    version: "cloud",
    author: "You",
    tags: [],
    appId: "app-1",
    namespaceId: "ns-work",
    codeInstallable: false,
    liveViewable: true,
    ...overrides,
  };
}

describe("isCommunityCatalogListed", () => {
  it("lists true public community apps only", () => {
    expect(
      isCommunityCatalogListed({
        visibility: "public_read",
        shareLinkEnabled: false,
        sharing: { loginAccess: "public", externalLink: "off" },
      }),
    ).toBe(true);
  });

  it("excludes invite-link visibilities", () => {
    expect(isCommunityCatalogListed({ visibility: "link_read" })).toBe(false);
    expect(isCommunityCatalogListed({ visibility: "link_read_write" })).toBe(
      false,
    );
  });

  it("excludes public_read rows that only enable external invite links", () => {
    expect(
      isCommunityCatalogListed({
        visibility: "public_read",
        shareLinkEnabled: true,
      }),
    ).toBe(false);
  });

  it("excludes link audience even when loginAccess is public", () => {
    expect(
      isCommunityCatalogListed({
        sharing: { loginAccess: "public", externalLink: "read" },
      }),
    ).toBe(false);
  });
});

describe("shouldIncludeInPublicCommunity — link-only apps", () => {
  const paprDir = "/tmp/papr-test";
  const ownedAppIds = new Set(["app-1"]);

  beforeEach(() => {
    getAppPublishPrefs.mockReset();
  });

  it("excludes owned link-only shares from global Community Apps", () => {
    getAppPublishPrefs.mockReturnValue({
      loginAccess: "none",
      externalLink: "read",
      codeAccess: "off",
    });

    const entry = cloudEntry({
      visibility: "link_read",
      shareLinkEnabled: true,
      isOwned: true,
    });
    expect(shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds)).toBe(
      false,
    );
  });

  it("excludes owned public+external-link shares from global Community Apps", () => {
    getAppPublishPrefs.mockReturnValue({
      loginAccess: "public",
      externalLink: "read",
      codeAccess: "off",
    });

    const entry = cloudEntry({
      visibility: "public_read",
      shareLinkEnabled: true,
      isOwned: true,
    });
    expect(shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds)).toBe(
      false,
    );
  });

  it("includes owned true public apps in global Community Apps", () => {
    getAppPublishPrefs.mockReturnValue({
      loginAccess: "public",
      externalLink: "off",
      codeAccess: "off",
    });

    const entry = cloudEntry({
      visibility: "public_read",
      isOwned: true,
    });
    expect(shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds)).toBe(
      true,
    );
  });

  it("keeps team+link apps in workspace Team Apps only", () => {
    getAppPublishPrefs.mockReturnValue({
      loginAccess: "team",
      externalLink: "read",
      codeAccess: "off",
    });

    const entry = cloudEntry({
      visibility: "team",
      shareLinkEnabled: true,
      isOwned: true,
    });
    expect(
      shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds, {
        allowTeam: true,
      }),
    ).toBe(true);
    expect(shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds)).toBe(
      false,
    );
  });
});
