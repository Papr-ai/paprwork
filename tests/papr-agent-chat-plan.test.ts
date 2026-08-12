import { describe, expect, it } from "vitest";
import {
  parsePlanFromToolResult,
  renderPlanCardHtml,
} from "../src/resources/mini-app-sdk/papr-agent-chat-plan.js";

describe("parsePlanFromToolResult", () => {
  const samplePlan = {
    planId: "plan-1",
    title: "Build dashboard",
    steps: [
      { id: "s1", description: "Create layout", status: "completed" as const },
      { id: "s2", description: "Wire data", status: "in_progress" as const },
    ],
  };

  it("parses create_plan wrapped result", () => {
    const result = JSON.stringify({ success: true, data: samplePlan });
    const plan = parsePlanFromToolResult("create_plan", result);
    expect(plan?.planId).toBe("plan-1");
    expect(plan?.steps).toHaveLength(2);
  });

  it("marks delete_plan as deleted", () => {
    const result = JSON.stringify({ success: true, data: samplePlan });
    const plan = parsePlanFromToolResult("delete_plan", result);
    expect(plan?.deleted).toBe(true);
  });

  it("returns null for unrelated tools", () => {
    expect(parsePlanFromToolResult("bash", "{}")).toBeNull();
  });
});

describe("renderPlanCardHtml", () => {
  it("renders progress and steps", () => {
    const html = renderPlanCardHtml(
      {
        planId: "plan-1",
        title: "Build dashboard",
        steps: [
          { id: "s1", description: "Create layout", status: "completed" },
          { id: "s2", description: "Wire data", status: "pending" },
        ],
      },
      false,
    );
    expect(html).toContain("Build dashboard");
    expect(html).toContain("1/2");
    expect(html).toContain("Create layout");
    expect(html).toContain("Wire data");
  });
});
