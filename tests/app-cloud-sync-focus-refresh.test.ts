import { describe, expect, it } from "vitest";

import {
  APP_CLOUD_SYNC_CLIENT_FRESH_MS,
  APP_CLOUD_SYNC_FOCUS_DEBOUNCE_MS,
  isAppCloudSyncCacheFresh,
} from "../ui/utils/appCloudSyncFocusRefresh.js";

describe("appCloudSyncFocusRefresh", () => {
  it("exports debounce and freshness constants", () => {
    expect(APP_CLOUD_SYNC_FOCUS_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(APP_CLOUD_SYNC_CLIENT_FRESH_MS).toBeGreaterThan(20_000);
  });

  it("treats cache as fresh inside the window", () => {
    const now = 1_000_000;
    expect(
      isAppCloudSyncCacheFresh(now - APP_CLOUD_SYNC_CLIENT_FRESH_MS + 1, now),
    ).toBe(true);
  });

  it("treats cache as stale at or beyond the window", () => {
    const now = 1_000_000;
    expect(
      isAppCloudSyncCacheFresh(now - APP_CLOUD_SYNC_CLIENT_FRESH_MS, now),
    ).toBe(false);
    expect(isAppCloudSyncCacheFresh(null, now)).toBe(false);
  });
});
