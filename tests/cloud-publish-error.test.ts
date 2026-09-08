import { describe, expect, it, beforeEach } from "vitest";
import { handleCloudPublishError } from "../ui/utils/cloudPublishError";
import { usePaprQuotaStore } from "../ui/stores/paprQuotaStore";

describe("cloudPublishError", () => {
  beforeEach(() => {
    usePaprQuotaStore.setState({ active: null, dismissedKey: null });
  });

  it("routes quota errors to the global banner and hides the bar summary", () => {
    const result = handleCloudPublishError(
      new Error(
        'Cloud publish failed (403): {"detail":"You\'ve reached the 1,000 mini interactions limit for your Developer plan."}',
      ),
    );

    expect(result.quotaBannerShown).toBe(true);
    expect(result.barMessage).toBeNull();
    expect(result.detailMessage).toContain("Operations limit reached");
    expect(usePaprQuotaStore.getState().active?.kind).toBe("operations");
  });

  it("keeps non-quota errors in the publish bar summary", () => {
    const result = handleCloudPublishError(
      new Error("Cloud publish failed (500): upstream timeout while uploading assets"),
    );

    expect(result.quotaBannerShown).toBe(false);
    expect(result.barMessage).toContain("upstream timeout");
    expect(result.detailMessage).toContain("upstream timeout");
  });
});
