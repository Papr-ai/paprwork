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

// Type alias for any tool - necessary for registry storage
// Mastra's Tool type has 7 generics, using 'any' is necessary for a generic registry
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any, any, any, any, any, any>;

export class ToolRegistry {
  private tools: Map<string, AnyTool>;

  constructor() {
    this.tools = new Map();
  }

  /**
   * Register a tool
   */
  register(tool: AnyTool): void {
    this.tools.set(tool.id, tool);
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
    return this.tools.get(toolId);
  }

  /**
   * Get all tools as object for Mastra Agent
   */
  getTools(): Record<string, AnyTool> {
    const toolsObject: Record<string, AnyTool> = {};
    for (const [id, tool] of this.tools) {
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
    const toolsObject: Record<string, AnyTool> = {};
    for (const [id, tool] of this.tools) {
      if (allowed.has(id)) {
        toolsObject[id] = tool;
      }
    }
    return toolsObject;
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
    return this.tools.has(toolId);
  }

  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear();
  }
}
