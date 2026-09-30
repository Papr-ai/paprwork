import { describe, expect, it } from "vitest";
import {
  buildMiniAppDistEtag,
  ifNoneMatchIncludes,
  MINI_APP_DIST_CACHE_CONTROL,
  readIfNoneMatchHeader,
} from "../src/gateway/utils/miniAppDistCache.js";

describe("miniAppDistCache", () => {
  it("builds a weak etag from mtime and size", () => {
    const etag = buildMiniAppDistEtag({ mtimeMs: 1_700_000_000_000, size: 346_273 });
    expect(etag).toBe('W/"1700000000000-346273"');
  });

  it("matches a single If-None-Match value", () => {
    const etag = buildMiniAppDistEtag({ mtimeMs: 100, size: 200 });
    expect(ifNoneMatchIncludes(etag, etag)).toBe(true);
    expect(ifNoneMatchIncludes('"other"', etag)).toBe(false);
  });

  it("matches comma-separated If-None-Match values and *", () => {
    const etag = buildMiniAppDistEtag({ mtimeMs: 100, size: 200 });
    expect(ifNoneMatchIncludes(`"stale", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchIncludes("*", etag)).toBe(true);
  });

  it("reads if-none-match from request headers", () => {
    expect(
      readIfNoneMatchHeader({ "if-none-match": 'W/"abc-1"' }),
    ).toBe('W/"abc-1"');
    expect(readIfNoneMatchHeader({})).toBeUndefined();
  });

  it("uses private must-revalidate cache control", () => {
    expect(MINI_APP_DIST_CACHE_CONTROL).toBe("private, must-revalidate");
  });
});
