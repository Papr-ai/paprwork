import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildLocalCatalogConfigFromPrefs } from "../src/gateway/services/CommunityCatalogService.js";

describe("buildLocalCatalogConfigFromPrefs", () => {
  const priorNamespace = process.env.PAPR_NAMESPACE_ID;
  const priorHost = process.env.PAPR_CLOUD_APPS_HOST;

  beforeEach(() => {
    process.env.PAPR_NAMESPACE_ID = "ns-test";
    process.env.PAPR_CLOUD_APPS_HOST = "https://apps.example.test";
  });

  afterEach(() => {
    if (priorNamespace === undefined) {
      delete process.env.PAPR_NAMESPACE_ID;
    } else {
      process.env.PAPR_NAMESPACE_ID = priorNamespace;
    }
    if (priorHost === undefined) {
      delete process.env.PAPR_CLOUD_APPS_HOST;
    } else {
      process.env.PAPR_CLOUD_APPS_HOST = priorHost;
    }
  });

  it("returns disabled when auto-publish is off and no cached token", () => {
    const config = buildLocalCatalogConfigFromPrefs(
      "app-1",
      "/tmp/nonexistent-papr",
      { title: "My Dashboard" },
      "ns-test",
    );
    expect(config.enabled).toBe(false);
    expect(config.shareUrl).toBeNull();
  });
});
