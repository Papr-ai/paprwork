import { describe, expect, it } from "vitest";
import { agenticGraphEnabled, grepCloudMemoryEnabled } from "../../src/core/tools/searchDefaults.js";

describe("search latency defaults", () => {
  it("agentic graph is off unless PAPR_AGENTIC_GRAPH=1", () => {
    expect(agenticGraphEnabled({})).toBe(false);
    expect(agenticGraphEnabled({ PAPR_AGENTIC_GRAPH: "0" })).toBe(false);
    expect(agenticGraphEnabled({ PAPR_AGENTIC_GRAPH: "1" })).toBe(true);
    expect(agenticGraphEnabled({ PAPR_AGENTIC_GRAPH: "true" })).toBe(true);
  });
  it("cloud memory search alongside grep is off unless PAPR_GREP_CLOUD_MEMORY=1", () => {
    expect(grepCloudMemoryEnabled({})).toBe(false);
    expect(grepCloudMemoryEnabled({ PAPR_GREP_CLOUD_MEMORY: "1" })).toBe(true);
  });
});
