import { describe, expect, it } from "vitest";
import {
  getAgentService,
  onAgentServiceCreated,
  resetAgentServiceSingletonForTests,
} from "../AgentService.js";

describe("MCP tool sink survives AgentService reset", () => {
  it("re-attaches to the new instance's ToolRegistry", () => {
    resetAgentServiceSingletonForTests();
    const seen: unknown[] = [];
    onAgentServiceCreated((svc) => {
      seen.push(svc.getToolRegistry());
    });

    const first = getAgentService();
    resetAgentServiceSingletonForTests();
    const second = getAgentService();

    expect(second).not.toBe(first);
    expect(seen).toContain(first.getToolRegistry());
    expect(seen).toContain(second.getToolRegistry());
    resetAgentServiceSingletonForTests();
  });
});
