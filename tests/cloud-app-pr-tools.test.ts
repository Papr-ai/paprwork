import { describe, expect, it } from "vitest";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ToolRegistry } from "../src/core/agents/ToolRegistry.js";
import {
  CLOUD_APP_PR_TOOL_IDS,
  resolveCloudAppPrToolAlias,
} from "../src/core/tools/cloudAppPrToolIds.js";
import { allTools } from "../src/core/tools/index.js";

describe("cloud app PR tool ids", () => {
  it("maps legacy change-request ids to canonical PR ids", () => {
    expect(resolveCloudAppPrToolAlias("list_cloud_app_changes")).toBe(
      CLOUD_APP_PR_TOOL_IDS.list,
    );
    expect(resolveCloudAppPrToolAlias("get_cloud_app_change_review")).toBe(
      CLOUD_APP_PR_TOOL_IDS.review,
    );
    expect(resolveCloudAppPrToolAlias("list_cloud_app_prs")).toBe(
      CLOUD_APP_PR_TOOL_IDS.list,
    );
  });

  it("registers canonical PR tool ids on primary tools", () => {
    const ids = new Set(allTools.map((t) => t.id));
    for (const id of Object.values(CLOUD_APP_PR_TOOL_IDS)) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

describe("ToolRegistry PR legacy alias resolution", () => {
  const primary = createTool({
    id: CLOUD_APP_PR_TOOL_IDS.list,
    description: "test",
    inputSchema: z.object({}),
    execute: async () => ({ success: true }),
  });

  it("resolves legacy id to canonical tool for getTool and allowlists", () => {
    const registry = new ToolRegistry();
    registry.register(primary as never);

    expect(registry.getTool("list_cloud_app_changes")).toBe(primary);
    expect(registry.hasTool("list_cloud_app_changes")).toBe(true);

    const allowed = registry.getToolsForMastra(["list_cloud_app_changes"]);
    expect(allowed.list_cloud_app_changes).toBe(primary);
  });
});
