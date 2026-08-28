import { describe, expect, it } from "vitest";
import { shouldBypassRepoFileCache } from "../src/gateway/services/appRuntime/cloudAppHostRequestCache.js";
import { parseCloudRepoHeadContent } from "../src/gateway/services/cloudSync/cloudRepoHeadMarker.js";
import { appendDistAssetCacheBusters, appendLegacyTypeScriptCacheBusters } from "../src/gateway/utils/miniAppBuild.js";

describe("shouldBypassRepoFileCache", () => {
  it("treats normal browser reload (max-age=0) as revalidation", () => {
    expect(
      shouldBypassRepoFileCache({ "cache-control": "max-age=0" }),
    ).toBe(true);
  });

  it("treats hard reload (no-cache) as revalidation", () => {
    expect(
      shouldBypassRepoFileCache({ "cache-control": "no-cache" }),
    ).toBe(true);
  });

  it("does not bypass warm navigation without revalidation headers", () => {
    expect(shouldBypassRepoFileCache({})).toBe(false);
  });
});

describe("parseCloudRepoHeadContent", () => {
  it("parses a git sha from the marker file", () => {
    expect(parseCloudRepoHeadContent("abc1234\n")).toBe("abc1234");
  });

  it("returns 0 for invalid marker content", () => {
    expect(parseCloudRepoHeadContent("not-a-sha")).toBe("0");
  });
});

describe("appendDistAssetCacheBusters", () => {
  it("appends version query params to dist assets", () => {
    const html =
      '<script type="module" src="dist/app.js"></script><link rel="stylesheet" href="dist/app.css">';
    const out = appendDistAssetCacheBusters(html, {
      appJs: "deadbeef",
      appCss: "cafebabe",
    });
    expect(out).toContain('src="dist/app.js?v=deadbeef"');
    expect(out).toContain('href="dist/app.css?v=cafebabe"');
  });
});

describe("appendLegacyTypeScriptCacheBusters", () => {
  it("appends version query params to legacy app.ts entry scripts", () => {
    const html =
      '<script src="app.ts"></script><script src="./main.tsx"></script>';
    const out = appendLegacyTypeScriptCacheBusters(html, "rev123");
    expect(out).toContain('src="app.ts?v=rev123"');
    expect(out).toContain('src="./main.tsx?v=rev123"');
  });
});
