/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { CloudPublishState } from "../ui/utils/cloudPublishApi";
import {
  readCachedCloudPublishState,
  writeCachedCloudPublishState,
} from "../ui/utils/cloudPublishCache";

const STORAGE_KEY = "paprwork.cloudPublishSnapshot.v1";

function sampleState(appId: string): CloudPublishState {
  return {
    appId,
    enabled: true,
    accessMode: "link_read_write",
    loginAccess: "team",
    externalLink: "read_write",
    shareUrl: "https://apps.papr.ai/ns-demo/my-app",
    shareToken: "token-abc",
    slug: "my-app",
    publishedAt: "2026-07-05T00:00:00.000Z",
  };
}

describe("cloudPublishCache", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it("persists and reads per-app publish state", () => {
    writeCachedCloudPublishState("app-1", sampleState("app-1"));
    const cached = readCachedCloudPublishState("app-1");
    expect(cached?.enabled).toBe(true);
    expect(cached?.shareUrl).toContain("my-app");
  });

  it("returns null when app is not cached", () => {
    expect(readCachedCloudPublishState("missing")).toBeNull();
  });

  it("clears cache entry when state is null", () => {
    writeCachedCloudPublishState("app-1", sampleState("app-1"));
    writeCachedCloudPublishState("app-1", null);
    expect(readCachedCloudPublishState("app-1")).toBeNull();
  });

  it("refuses to write publish state under the wrong app id", () => {
    writeCachedCloudPublishState("app-1", sampleState("app-1"));
    writeCachedCloudPublishState("app-2", sampleState("app-1"));
    expect(readCachedCloudPublishState("app-2")).toBeNull();
    expect(readCachedCloudPublishState("app-1")?.loginAccess).toBe("team");
  });
});
