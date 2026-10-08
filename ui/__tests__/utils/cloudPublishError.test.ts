import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/paprQuotaStore", () => ({
  usePaprQuotaStore: { getState: () => ({ setQuotaStatus: vi.fn() }) },
}));

import { handleCloudPublishError, readablePublishError } from "../../utils/cloudPublishError";

const READABLE = "Couldn't reach Papr Cloud. Check your connection and try again.";

describe("readablePublishError", () => {
  it.each(["fetch failed", "TypeError: Failed to fetch", "connect ECONNREFUSED 127.0.0.1", "socket hang up", "getaddrinfo ENOTFOUND api.papr.ai", "UND_ERR_CONNECT_TIMEOUT"])(
    "turns %s into a readable reason",
    (raw) => expect(readablePublishError(raw)).toBe(READABLE),
  );

  it("keeps real server messages as they are", () => {
    expect(readablePublishError("Slug already taken")).toBe("Slug already taken");
  });
});

describe("handleCloudPublishError", () => {
  it("a dropped connection becomes a readable detail", () => {
    const r = handleCloudPublishError(new TypeError("fetch failed"));
    expect(r.detailMessage).toBe(READABLE);
    expect(r.barMessage).toBe("Failed to publish");
  });
});
