import { describe, expect, test, vi, beforeEach } from "vitest";
import type Papr from "@papr/memory";
import {
  fetchSyncTiersThrottled,
  getSyncTiersRetryAfterMs,
  hasSyncTiersInFlight,
  recordSyncTiersFailure,
  resetSyncTiersClientForTests,
  shouldAttemptSyncTiers,
  SYNC_TIERS_FAILURE_BACKOFF_MS,
  SyncTiersBackoffError,
} from "../src/gateway/services/syncTiersClient.js";

function mockClient(
  impl?: () => Promise<{ tier0: []; tier1: [] }>,
): Papr {
  return {
    sync: {
      getTiers: vi.fn(
        impl ??
          (async () => ({
            tier0: [],
            tier1: [],
          })),
      ),
    },
  } as unknown as Papr;
}

describe("syncTiersClient", () => {
  beforeEach(() => {
    resetSyncTiersClientForTests();
    vi.useRealTimers();
  });

  test("dedupes concurrent in-flight requests per user", async () => {
    const client = mockClient(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ tier0: [], tier1: [] }), 20);
        }),
    );
    const params = {
      max_tier0: 10,
      max_tier1: 10,
      include_embeddings: false,
    };

    const first = fetchSyncTiersThrottled(client, "user-1", params);
    expect(hasSyncTiersInFlight("user-1")).toBe(true);

    const second = fetchSyncTiersThrottled(client, "user-1", params);
    await expect(first).resolves.toEqual({ tier0: [], tier1: [] });
    await expect(second).resolves.toEqual({ tier0: [], tier1: [] });
    expect(client.sync.getTiers).toHaveBeenCalledTimes(1);
  });

  test("applies failure backoff for background retries", async () => {
    const client = mockClient(async () => {
      throw new Error("429 rate limit");
    });
    const params = {
      max_tier0: 10,
      max_tier1: 10,
      include_embeddings: false,
    };

    await expect(
      fetchSyncTiersThrottled(client, "user-1", params),
    ).rejects.toThrow("429 rate limit");

    expect(shouldAttemptSyncTiers("user-1")).toBe(false);
    await expect(
      fetchSyncTiersThrottled(client, "user-1", params),
    ).rejects.toBeInstanceOf(SyncTiersBackoffError);
    expect(client.sync.getTiers).toHaveBeenCalledTimes(1);
  });

  test("force bypasses failure backoff", async () => {
    recordSyncTiersFailure("user-1", Date.now());
    expect(getSyncTiersRetryAfterMs("user-1")).toBeGreaterThan(0);

    const client = mockClient(async () => ({ tier0: [], tier1: [] }));
    await expect(
      fetchSyncTiersThrottled(
        client,
        "user-1",
        {
          max_tier0: 10,
          max_tier1: 10,
          include_embeddings: false,
        },
        { force: true },
      ),
    ).resolves.toEqual({ tier0: [], tier1: [] });
  });

  test("backoff expires after window", () => {
    const now = Date.now();
    recordSyncTiersFailure("user-1", now - SYNC_TIERS_FAILURE_BACKOFF_MS - 1);
    expect(shouldAttemptSyncTiers("user-1", now)).toBe(true);
  });
});
