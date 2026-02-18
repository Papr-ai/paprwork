import { describe, expect, test } from "vitest";
import { getAllToolIds } from "../src/core/tools/index.js";

describe("Sub-agent tool registry", () => {
  test("registers sub-agent orchestration tools", () => {
    const ids = getAllToolIds();
    expect(ids).toContain("list_sub_agents");
    expect(ids).toContain("create_sub_agent");
    expect(ids).toContain("delete_sub_agent");
    expect(ids).toContain("delegate_task");
    expect(ids).toContain("get_delegation_run");
    expect(ids).toContain("list_delegation_runs");
  });
});
