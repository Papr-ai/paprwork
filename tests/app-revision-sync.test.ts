import { afterEach, describe, expect, it } from "vitest";
import {
  AppRevisionHub,
  resetAppRevisionHubForTests,
} from "../src/gateway/services/appRuntime/AppRevisionHub.js";
import {
  invalidateRepoCacheForPublishedApp,
  resetCloudAppHostCachesForTests,
} from "../src/gateway/services/appRuntime/cloudAppHostCache.js";
import {
  parsePublishedAppRoute,
} from "../src/gateway/services/cloudSync/notifyCloudAppRevision.js";

describe("parsePublishedAppRoute", () => {
  it("parses namespace and slug from share URL", () => {
    expect(
      parsePublishedAppRoute("https://apps.papr.ai/vVpht1wnRb/audit-workbench/"),
    ).toEqual({
      namespaceId: "vVpht1wnRb",
      slug: "audit-workbench",
    });
  });

  it("returns null for invalid URLs", () => {
    expect(parsePublishedAppRoute(null)).toBeNull();
    expect(parsePublishedAppRoute("https://apps.papr.ai/")).toBeNull();
  });
});

describe("AppRevisionHub", () => {
  afterEach(() => {
    resetAppRevisionHubForTests();
  });

  it("delivers revision events to subscribers", () => {
    const hub = new AppRevisionHub();
    const seen: string[] = [];
    hub.subscribe((event) => {
      if (event.namespaceId === "ns-1" && event.slug === "app") {
        seen.push(event.revision);
      }
    });

    hub.publish({ namespaceId: "ns-1", slug: "app", revision: "abc:1111" });
    hub.publish({ namespaceId: "ns-2", slug: "other", revision: "def:2222" });

    expect(seen).toEqual(["abc:1111"]);
  });
});

describe("invalidateRepoCacheForPublishedApp", () => {
  afterEach(() => {
    resetCloudAppHostCachesForTests();
  });

  it("is safe to call when no cache entries exist", () => {
    expect(() =>
      invalidateRepoCacheForPublishedApp("ns-1", "my-app"),
    ).not.toThrow();
  });
});
