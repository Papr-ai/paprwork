import { describe, expect, it } from "vitest";
import { runtimeAuthPayload } from "../src/gateway/services/appRuntime/memoryRuntimeClient.js";

describe("runtimeAuthPayload", () => {
  it("includes external_user_id when visitor is signed in", () => {
    const payload = runtimeAuthPayload({
      namespaceId: "ns-1",
      slug: "my-app",
      sessionToken: "sess-abc",
      externalUserId: "visitor-123",
    });
    expect(payload.external_user_id).toBe("visitor-123");
    expect(payload.namespaceId).toBe("ns-1");
  });

  it("omits external_user_id for anonymous share-link visitors", () => {
    const payload = runtimeAuthPayload({
      namespaceId: "ns-1",
      slug: "my-app",
      shareToken: "share-tok",
    });
    expect(payload.external_user_id).toBeUndefined();
  });
});
