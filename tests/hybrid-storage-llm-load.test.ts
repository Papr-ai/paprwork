import { describe, expect, it } from "vitest";
import { localLlmHistoryIncludesSummary } from "../src/gateway/services/storage/HybridStorageProvider.js";

describe("localLlmHistoryIncludesSummary", () => {
  it("returns false for plain message rows", () => {
    expect(
      localLlmHistoryIncludesSummary([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ).toBe(false);
  });

  it("returns true when local injected __summary", () => {
    expect(
      localLlmHistoryIncludesSummary([
        { __summary: "Earlier context…" },
        { role: "user", content: "hello" },
      ]),
    ).toBe(true);
  });

  it("returns false for nullish entries", () => {
    expect(localLlmHistoryIncludesSummary([null, undefined, "x"])).toBe(false);
  });
});
