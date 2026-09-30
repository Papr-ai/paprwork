import { describe, expect, it } from "vitest";
import {
  delegateTaskArgsFromToolCall,
  isDelegateTaskInvocation,
  parseDelegationFromToolCall,
} from "../ui/utils/delegationFromToolCall";

describe("delegationFromToolCall", () => {
  it("recognizes run_deferred_tool wrapping delegate_task", () => {
    expect(
      isDelegateTaskInvocation("run_deferred_tool", {
        tool_name: "delegate_task",
        arguments: { useAgentId: "product-architect", task: "Brief" },
      }),
    ).toBe(true);
    expect(isDelegateTaskInvocation("run_deferred_tool", { tool_name: "bash" })).toBe(
      false,
    );
  });

  it("unwraps nested delegate args", () => {
    const inner = delegateTaskArgsFromToolCall("run_deferred_tool", {
      tool_name: "delegate_task",
      arguments: { task: "SEO weekly", useAgentId: "product-architect" },
    });
    expect(inner?.task).toBe("SEO weekly");
    expect(inner?.useAgentId).toBe("product-architect");
  });

  it("parses delegate_task result from run_deferred_tool", () => {
    const parsed = parseDelegationFromToolCall("run_deferred_tool", {
      success: true,
      data: {
        id: "29f0132e-fb81-4310-96de-0d573dddb3ed",
        agentId: "product-architect",
        task: "Architecture brief",
        status: "running",
      },
    });
    expect(parsed?.id).toBe("29f0132e-fb81-4310-96de-0d573dddb3ed");
    expect(parsed?.task).toBe("Architecture brief");
    expect(parsed?.status).toBe("running");
  });
});
