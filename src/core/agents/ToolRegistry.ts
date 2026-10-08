/**
 * Tool registry - Manages available tools for agents
 *
 * Note: This file uses 'any' for tool type parameters due to TypeScript's generic variance.
 * Mastra's Tool type has 7 generic parameters, and storing tools with different
 * specific types in a Map requires using 'any' or 'unknown' for the generics.
 *
 * This is a standard pattern when building registries for generic types.
 * The types are validated at tool creation time, and runtime behavior is type-safe.
 *
 * This file is exempt from no-explicit-any rule (see .eslintrc.json overrides).
 */

import type { Tool } from "@mastra/core/tools";
import { resolveCloudAppPrToolAlias } from "../tools/cloudAppPrToolIds.js";

// Type alias for any tool - necessary for registry storage
// Mastra's Tool type has 7 generics, using 'any' is necessary for a generic registry
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any, any, any, any, any, any>;

/** Remote MCP tool ids: `<server>__<tool>` (see mcpToolAdapter.mcpAgentToolId). */
const MCP_TOOL_ID = /^[a-z][a-z0-9_]*__[A-Za-z0-9_-]+$/;

export class ToolRegistry {
  private tools: Map<string, AnyTool>;
  /** Legacy alias tools — available only when explicitly allowlisted (sub-agent profiles). */
  private legacyToolIds: Set<string>;

  constructor() {
    this.tools = new Map();
    this.legacyToolIds = new Set();
  }

  /**
   * Register a primary tool (visible to the main agent by default).
   */
  register(tool: AnyTool): void {
    this.tools.set(tool.id, tool);
  }

  /**
   * Register a legacy alias (e.g. edit_app_file → same backend as edit_file).
   * Hidden from the main agent unless explicitly allowlisted.
   */
  registerLegacy(tool: AnyTool): void {
    this.tools.set(tool.id, tool);
    this.legacyToolIds.add(tool.id);
  }

  /**
   * Unregister a tool
   */
  unregister(toolId: string): void {
    this.tools.delete(toolId);
  }

  /**
   * Get tool by ID
   */
  getTool(toolId: string): AnyTool | undefined {
    const resolved = resolveCloudAppPrToolAlias(toolId);
    return this.tools.get(resolved) ?? this.tools.get(toolId);
  }

  /**
   * Get all tools as object for Mastra Agent (excludes legacy aliases by default).
   */
  getTools(options?: { includeLegacy?: boolean }): Record<string, AnyTool> {
    const includeLegacy = options?.includeLegacy ?? false;
    const toolsObject: Record<string, AnyTool> = {};
    for (const [id, tool] of this.tools) {
      if (!includeLegacy && this.legacyToolIds.has(id)) continue;
      toolsObject[id] = tool;
    }
    return toolsObject;
  }

  /**
   * Get tools formatted for Mastra's streamText
   * Returns tools object ready to be passed to AI SDK
   */
  getToolsForMastra(allowedToolIds?: string[]): Record<string, AnyTool> {
    if (!allowedToolIds || allowedToolIds.length === 0) {
      return this.getTools();
    }
    const allowed = new Set(allowedToolIds);
    // Connected MCP servers register `<server>__<tool>` at runtime, so a fixed
    // allowlist can't name them. `mcp:linear` grants every Linear tool,
    // `mcp:*` every connected server's tools.
    const mcpAll = allowed.has("mcp:*");
    const mcpPrefixes = allowedToolIds
      .filter((id) => id.startsWith("mcp:") && id !== "mcp:*")
      .map((id) => `${id.slice(4).replace(/-/g, "_")}__`);
    const toolsObject: Record<string, AnyTool> = {};
    for (const [id, tool] of this.tools) {
      if (allowed.has(id)) {
        toolsObject[id] = tool;
        continue;
      }
      if ((mcpAll || mcpPrefixes.length > 0) && id.includes("__") && !this.legacyToolIds.has(id)) {
        if (mcpAll ? MCP_TOOL_ID.test(id) : mcpPrefixes.some((p) => id.startsWith(p))) {
          toolsObject[id] = tool;
        }
      }
    }
    for (const requestedId of allowedToolIds) {
      if (toolsObject[requestedId]) {
        continue;
      }
      const resolved = resolveCloudAppPrToolAlias(requestedId);
      if (resolved === requestedId) {
        continue;
      }
      const tool = this.tools.get(resolved);
      if (tool && !this.legacyToolIds.has(requestedId)) {
        toolsObject[requestedId] = tool;
      }
    }
    return toolsObject;
  }

  /** Primary tool IDs (excludes legacy aliases). */
  getMainToolIds(): string[] {
    return Array.from(this.tools.keys()).filter(
      (id) => !this.legacyToolIds.has(id),
    );
  }

  isLegacyTool(toolId: string): boolean {
    return this.legacyToolIds.has(toolId);
  }

  /**
   * Get all tool IDs
   */
  getToolIds(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if tool exists
   */
  hasTool(toolId: string): boolean {
    const resolved = resolveCloudAppPrToolAlias(toolId);
    return this.tools.has(resolved) || this.tools.has(toolId);
  }

  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear();
  }
}
