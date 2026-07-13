import { describe, expect, it } from "vitest";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ToolRegistry } from "../src/core/agents/ToolRegistry.js";

const primaryTool = createTool({
  id: "edit_file",
  description: "test",
  inputSchema: z.object({ path: z.string() }),
  execute: async () => ({ success: true }),
});

const legacyTool = createTool({
  id: "edit_app_file",
  description: "legacy",
  inputSchema: z.object({ appId: z.string() }),
  execute: async () => ({ success: true }),
});

describe("ToolRegistry legacy alias filtering", () => {
  it("hides legacy tools from main agent, keeps them for allowlists", () => {
    const registry = new ToolRegistry();
    registry.register(primaryTool as never);
    registry.registerLegacy(legacyTool as never);

    const main = registry.getToolsForMastra();
    expect(Object.keys(main)).toEqual(["edit_file"]);

    const subAgent = registry.getToolsForMastra(["edit_app_file"]);
    expect(Object.keys(subAgent)).toEqual(["edit_app_file"]);

    expect(registry.getMainToolIds()).toEqual(["edit_file"]);
    expect(registry.isLegacyTool("edit_app_file")).toBe(true);
  });
});
