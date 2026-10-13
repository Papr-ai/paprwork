import { describe, expect, it } from "vitest";
import { getToolDisplayLabel } from "../../utils/toolDisplay.js";

describe("getToolDisplayLabel — run_deferred_tool", () => {
  it("unwraps push_cloud_sync with app scope", () => {
    const label = getToolDisplayLabel({
      toolName: "run_deferred_tool",
      status: "calling",
      args: {
        tool_name: "push_cloud_sync",
        arguments: { appId: "8eceb42a-6d89-4aee-b504-ddce8bf19483" },
      },
    });
    expect(label).toContain("Pushing cloud sync");
    expect(label).toContain("8eceb42a");
    expect(label).not.toContain("run deferred");
  });

  it("unwraps bash commands", () => {
    const label = getToolDisplayLabel({
      toolName: "run_deferred_tool",
      status: "calling",
      args: {
        tool_name: "bash",
        arguments: { command: "curl https://example.com/api" },
      },
    });
    expect(label).toContain("example.com");
  });

  it("falls back when inner name is missing", () => {
    const label = getToolDisplayLabel({
      toolName: "run_deferred_tool",
      status: "calling",
      args: {},
    });
    expect(label).toBe("Running deferred tool");
  });
});
