import { describe, expect, test } from "vitest";
import {
  getSyncTiersFailureBackoffRemainingMs,
  MEMORY_PREVIEW_SYNC_TIERS_FAILURE_BACKOFF_MS,
  shouldQueueMemoryPreviewRefresh,
} from "../src/gateway/services/MemoryPreviewCache.js";

describe("MemoryPreviewCache refresh gating", () => {
  test("does not queue when cache is fresh and complete", () => {
    expect(
      shouldQueueMemoryPreviewRefresh({
        isFresh: true,
        isIncomplete: false,
      }),
    ).toBe(false);
  });

  test("queues when stale and no failure backoff", () => {
    expect(
      shouldQueueMemoryPreviewRefresh({
        isFresh: false,
        isIncomplete: false,
      }),
    ).toBe(true);
  });

  test("skips queue while preview refresh is in flight", () => {
    expect(
      shouldQueueMemoryPreviewRefresh({
        isFresh: false,
        isIncomplete: true,
        previewRefreshInFlight: true,
      }),
    ).toBe(false);
  });

  test("respects sync tiers failure backoff", () => {
    const failedAt = new Date(
      Date.now() - MEMORY_PREVIEW_SYNC_TIERS_FAILURE_BACKOFF_MS + 60_000,
    ).toISOString();

    expect(getSyncTiersFailureBackoffRemainingMs(failedAt)).toBeGreaterThan(0);
    expect(
      shouldQueueMemoryPreviewRefresh({
        isFresh: false,
        isIncomplete: true,
        syncTiersFailedAt: failedAt,
      }),
    ).toBe(false);
  });
});
