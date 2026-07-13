import { describe, expect, it } from "vitest";
import {
  ensurePublishedAppRootTrailingSlash,
  injectPublishedAppBaseHref,
  isPublishedAppRootPath,
  publishedAppBaseHref,
} from "../src/core/utils/cloudAppPath.js";

describe("cloudAppPath", () => {
  it("detects published app root paths", () => {
    expect(isPublishedAppRootPath("/ns/my-app")).toBe(true);
    expect(isPublishedAppRootPath("/ns/my-app/")).toBe(true);
    expect(isPublishedAppRootPath("/ns/my-app/layout.css")).toBe(false);
  });

  it("adds trailing slash for app roots", () => {
    expect(ensurePublishedAppRootTrailingSlash("/ns/my-app")).toBe("/ns/my-app/");
    expect(ensurePublishedAppRootTrailingSlash("/ns/my-app/")).toBe("/ns/my-app/");
    expect(ensurePublishedAppRootTrailingSlash("/ns/my-app/layout.css")).toBe(
      "/ns/my-app/layout.css",
    );
  });

  it("builds base href for relative assets", () => {
    expect(publishedAppBaseHref("ns1", "slug")).toBe("/ns1/slug/");
  });

  it("injects base tag into html head", () => {
    const html = injectPublishedAppBaseHref(
      "<!DOCTYPE html><html><head><title>App</title></head><body></body></html>",
      "/ns/slug/",
    );
    expect(html).toContain('<base href="/ns/slug/">');
  });
});
