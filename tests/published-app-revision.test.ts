import { describe, expect, it } from "vitest";
import {
  formatPublishedAppRevision,
  injectPaprAppRevisionMeta,
  PAPR_APP_REVISION_META_NAME,
} from "../src/gateway/services/appRuntime/publishedAppRevision.js";

describe("formatPublishedAppRevision", () => {
  it("combines repo head and dist hash for bundled apps", () => {
    expect(formatPublishedAppRevision("abc1234", "console.log('hi')")).toMatch(
      /^abc1234:[0-9a-f]{16}$/,
    );
  });

  it("returns repo head only when dist is missing", () => {
    expect(formatPublishedAppRevision("abc1234", null)).toBe("abc1234");
  });

  it("returns null when no revision markers exist", () => {
    expect(formatPublishedAppRevision("0", null)).toBeNull();
  });
});

describe("injectPaprAppRevisionMeta", () => {
  it("injects revision meta into head", () => {
    const html = "<html><head></head><body></body></html>";
    const out = injectPaprAppRevisionMeta(html, "abc1234:deadbeef01234567");
    expect(out).toContain(
      `<meta name="${PAPR_APP_REVISION_META_NAME}" content="abc1234:deadbeef01234567">`,
    );
  });

  it("replaces an existing revision meta tag", () => {
    const html = `<html><head><meta name="${PAPR_APP_REVISION_META_NAME}" content="old"></head></html>`;
    const out = injectPaprAppRevisionMeta(html, "new:hash");
    expect(out).toContain(`content="new:hash"`);
    expect(out).not.toContain('content="old"');
  });
});
