import { describe, expect, it } from "vitest";

import {
  WARM_IFRAME_ACTIVATION_BASE_MS,
  WARM_IFRAME_ACTIVATION_SLOTS,
  WARM_IFRAME_ACTIVATION_STEP_MS,
  warmIframeActivationDelayMs,
} from "../ui/utils/appPreviewWarmActivation.js";

describe("warmIframeActivationDelayMs", () => {
  it("spreads delays across bounded slots", () => {
    const delays = new Set(
      Array.from({ length: 24 }, (_, index) =>
        warmIframeActivationDelayMs(`app-${index}`),
      ),
    );
    expect(delays.size).toBeGreaterThan(1);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(WARM_IFRAME_ACTIVATION_BASE_MS);
      expect(delay).toBeLessThanOrEqual(
        WARM_IFRAME_ACTIVATION_BASE_MS +
          (WARM_IFRAME_ACTIVATION_SLOTS - 1) * WARM_IFRAME_ACTIVATION_STEP_MS,
      );
    }
  });

  it("is stable for the same app id", () => {
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    expect(warmIframeActivationDelayMs(appId)).toBe(
      warmIframeActivationDelayMs(appId),
    );
  });
});
