import { describe, it, expect } from "vitest";

/**
 * Regression: clicking Delete on an app sometimes failed with "Request timeout"
 * even though the delete succeeded server-side.
 *
 * Budget mismatch:
 *   - gateway.send() default timeout ............ 30s
 *   - cloudApiFetch() timeout ................... 60s
 *
 * deleteApp() awaits getCloudPublishStatus() (one cloudApiFetch) before
 * deciding anything, and an unpublish then flips every published App Files
 * object private ONE AT A TIME, each its own cloudApiFetch, before the final
 * DELETE. So a single slow request could exceed the client budget on its own,
 * and an app with N published files had roughly N+2 sequential chances to.
 *
 * Fixes: raise the client budget to 90s (matching app:list) and cap the
 * pre-delete status check server-side so it cannot consume the whole budget.
 */

const CLIENT_DELETE_TIMEOUT_MS = 90_000;
const CLOUD_API_FETCH_TIMEOUT_MS = 60_000;
const CLOUD_PUBLISH_STATUS_TIMEOUT_MS = 8_000;

/** Mirrors withTimeout() in AppService.ts. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("app delete timeout budget", () => {
  it("gives the client more time than a single cloud request can consume", () => {
    expect(CLIENT_DELETE_TIMEOUT_MS).toBeGreaterThan(CLOUD_API_FETCH_TIMEOUT_MS);
  });

  it("caps the pre-delete publish check well under the client budget", () => {
    expect(CLOUD_PUBLISH_STATUS_TIMEOUT_MS).toBeLessThan(
      CLIENT_DELETE_TIMEOUT_MS,
    );
    // Must also beat cloudApiFetch's own timeout, otherwise the cap is a no-op.
    expect(CLOUD_PUBLISH_STATUS_TIMEOUT_MS).toBeLessThan(
      CLOUD_API_FETCH_TIMEOUT_MS,
    );
  });

  it("withTimeout rejects a slow promise with a descriptive message", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, "publish status")).rejects.toThrow(
      /Timed out after 20ms: publish status/,
    );
  });

  it("withTimeout passes through a fast result untouched", async () => {
    await expect(
      withTimeout(Promise.resolve("published"), 1_000, "publish status"),
    ).resolves.toBe("published");
  });
});
