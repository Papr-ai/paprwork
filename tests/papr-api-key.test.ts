import { describe, expect, it } from "vitest";
import { paprApiKeyMatchesNamespace } from "../src/core/utils/paprApiKey.js";

describe("paprApiKeyMatchesNamespace", () => {
  it("matches keys for the same org and namespace", () => {
    const apiKey =
      "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-abc123";

    expect(
      paprApiKeyMatchesNamespace(apiKey, "Y8D4H7Yp3Z", "onnNQFe3DN"),
    ).toBe(true);
  });

  it("rejects keys for a different namespace", () => {
    const apiKey =
      "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-abc123";

    expect(
      paprApiKeyMatchesNamespace(apiKey, "Y8D4H7Yp3Z", "S7mQcHZCtj"),
    ).toBe(false);
  });

  it("rejects keys for a different org", () => {
    const apiKey =
      "sk-org-De6SRb7yNd-namespace-S7mQcHZCtj-abc123";

    expect(
      paprApiKeyMatchesNamespace(apiKey, "Y8D4H7Yp3Z", "S7mQcHZCtj"),
    ).toBe(false);
  });
});
