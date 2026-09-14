import { afterEach, describe, expect, it } from "vitest";
import {
  clearSyncItemsAppResponseCacheForTests,
  getCachedSyncItemsAppResponse,
  invalidateSyncItemsAppResponseCache,
  setCachedSyncItemsAppResponse,
} from "../src/gateway/services/syncItemsAppResponseCache.js";

describe("syncItemsAppResponseCache", () => {
  afterEach(() => {
    clearSyncItemsAppResponseCacheForTests();
  });

  it("returns cached payload within TTL", () => {
    setCachedSyncItemsAppResponse("app-a", { enabled: true, tursoCached: true });
    expect(getCachedSyncItemsAppResponse("app-a")).toEqual({
      enabled: true,
      tursoCached: true,
    });
  });

  it("invalidates per app", () => {
    setCachedSyncItemsAppResponse("app-a", { enabled: true });
    setCachedSyncItemsAppResponse("app-b", { enabled: true });
    invalidateSyncItemsAppResponseCache("app-a");
    expect(getCachedSyncItemsAppResponse("app-a")).toBeNull();
    expect(getCachedSyncItemsAppResponse("app-b")).not.toBeNull();
  });
});
