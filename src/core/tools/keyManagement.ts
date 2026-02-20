/**
 * Key Management Tools - List, get, set, and delete custom API keys
 *
 * These tools allow agents to interact with the secure custom keys system:
 * - list_keys: See what keys are available (metadata only, no values)
 * - get_key: Retrieve a specific key value (for checking if it exists)
 * - set_key: Add or update a custom key
 * - delete_key: Remove a custom key
 *
 * Keys are stored securely using Electron's safeStorage API (macOS Keychain, etc.)
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolResult } from "../types/index.js";

/**
 * List all custom API keys (metadata only, no values)
 * Shows key names, descriptions, and permission levels
 */
export const listKeysTool = createTool({
  id: "list_keys",
  description:
    "List all custom API keys configured in Settings. Returns metadata (name, description, permission) but NOT values. Use this to check what keys are available before trying to use them.",
  inputSchema: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const startTime = performance.now();

    try {
      // Import dynamically to avoid circular dependencies
      const { getCustomKeysService } =
        await import("../../gateway/services/CustomKeysService.js");
      const service = getCustomKeysService();

      const keys = await service.listKeys();

      if (keys.length === 0) {
        return {
          success: true,
          data: {
            keys: [],
            message:
              "No custom keys configured yet. User can add keys in Settings → API Keys → Custom API Keys.",
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Return metadata only (no values for security)
      const metadata = keys.map((key) => ({
        name: key.name,
        description: key.description || "(no description)",
        permission: key.permission,
        createdAt: key.createdAt,
      }));

      return {
        success: true,
        data: {
          keys: metadata,
          count: keys.length,
          message: `Found ${keys.length} custom key(s). Use \${KEY_NAME} syntax in bash commands to reference them.`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

/**
 * Get a specific custom API key value
 * Used to check if a key exists and retrieve its value
 */
export const getKeyTool = createTool({
  id: "get_key",
  description:
    "Get the value of a specific custom API key by name. Use this to check if a required key exists. If the key doesn't exist, guide the user to add it in Settings → API Keys → Custom API Keys.",
  inputSchema: z.object({
    name: z
      .string()
      .describe("Key name (e.g., 'GITHUB_TOKEN', 'STRIPE_API_KEY')"),
  }),
  execute: async (inputData: any): Promise<ToolResult> => {
    const args = inputData.context || inputData;
    const startTime = performance.now();

    try {
      const { getCustomKeysService } =
        await import("../../gateway/services/CustomKeysService.js");
      const service = getCustomKeysService();

      const value = await service.getKeyByName(args.name);

      if (!value) {
        return {
          success: false,
          error: `Key '${args.name}' not found. User needs to add it in Settings → API Keys → Custom API Keys.`,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        success: true,
        data: {
          name: args.name,
          exists: true,
          valueLength: value.length,
          message: `Key '${args.name}' exists and is ${value.length} characters long. Use \${${args.name}} in bash commands to reference it.`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

/**
 * Add or update a custom API key
 * Should only be used when the user explicitly provides the key value
 */
export const setKeyTool = createTool({
  id: "set_key",
  description:
    "Add or update a custom API key. **Only use this when the user explicitly provides the key value.** Never ask users to paste keys in chat - direct them to Settings UI instead. This tool is for when the user wants to automate key setup programmatically.",
  inputSchema: z.object({
    name: z.string().describe("Key name in UPPER_CASE (e.g., 'GITHUB_TOKEN')"),
    value: z.string().describe("Key value (will be encrypted securely)"),
    description: z
      .string()
      .optional()
      .describe("Human-readable description of what this key is for"),
    permission: z
      .enum(["always", "ask"])
      .default("ask")
      .describe(
        "Permission level: 'always' = auto-approve for automation, 'ask' = require user approval each time",
      ),
  }),
  execute: async (inputData: any): Promise<ToolResult> => {
    const args = inputData.context || inputData;
    const startTime = performance.now();

    try {
      const { getCustomKeysService } =
        await import("../../gateway/services/CustomKeysService.js");
      const service = getCustomKeysService();

      // Validate key name format
      if (!/^[A-Z_][A-Z0-9_]*$/.test(args.name)) {
        return {
          success: false,
          error: `Invalid key name '${args.name}'. Must be UPPER_CASE with underscores, starting with a letter or underscore.`,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Check if key already exists
      const existing = await service.getKeyByName(args.name);
      const isUpdate = !!existing;

      // Add or update the key
      await service.addKey({
        name: args.name,
        value: args.value,
        description: args.description,
        permission: args.permission,
      });

      return {
        success: true,
        data: {
          name: args.name,
          action: isUpdate ? "updated" : "created",
          permission: args.permission,
          message: `Key '${args.name}' ${isUpdate ? "updated" : "created"} successfully. Use \${${args.name}} in bash commands to reference it.`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

/**
 * Delete a custom API key
 */
export const deleteKeyTool = createTool({
  id: "delete_key",
  description:
    "Delete a custom API key. Use this when the user wants to remove a key they no longer need. The key will be permanently removed from secure storage.",
  inputSchema: z.object({
    name: z.string().describe("Key name to delete (e.g., 'GITHUB_TOKEN')"),
  }),
  execute: async (inputData: any): Promise<ToolResult> => {
    const args = inputData.context || inputData;
    const startTime = performance.now();

    try {
      const { getCustomKeysService } =
        await import("../../gateway/services/CustomKeysService.js");
      const service = getCustomKeysService();

      // Check if key exists
      const existing = await service.getKeyByName(args.name);
      if (!existing) {
        return {
          success: false,
          error: `Key '${args.name}' not found. Nothing to delete.`,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      await service.deleteKey(args.name);

      return {
        success: true,
        data: {
          name: args.name,
          message: `Key '${args.name}' deleted successfully.`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

/**
 * Request a missing API key from the user
 * Shows an inline card in the chat where user can enter the key
 */
export const requestKeyTool = createTool({
  id: "request_key",
  description:
    "Request a missing API key from the user with an inline input card. Use this when you need a key that doesn't exist yet. The user will see a card in the chat where they can enter the key value directly, without leaving the conversation. Better UX than directing to Settings.",
  inputSchema: z.object({
    name: z.string().describe("Key name in UPPER_CASE (e.g., 'GITHUB_TOKEN')"),
    description: z
      .string()
      .describe(
        "What this key is for (e.g., 'GitHub API access for fetching repository data')",
      ),
    sourceUrl: z
      .string()
      .optional()
      .describe("Where to get the key (e.g., 'github.com/settings/tokens')"),
    requiredScopes: z
      .array(z.string())
      .optional()
      .describe(
        "Required API scopes/permissions (e.g., ['repo', 'read:user'])",
      ),
    permission: z
      .enum(["always", "ask"])
      .default("always")
      .describe(
        "Suggested permission level: 'always' = auto-approve for automation (RECOMMENDED), 'ask' = require approval each time (more secure)",
      ),
  }),
  execute: async (inputData: any): Promise<ToolResult> => {
    const args = inputData.context || inputData;
    const startTime = performance.now();

    try {
      // Validate key name format
      if (!/^[A-Z_][A-Z0-9_]*$/.test(args.name)) {
        return {
          success: false,
          error: `Invalid key name '${args.name}'. Must be UPPER_CASE with underscores, starting with a letter or underscore.`,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Check if key already exists
      const { getCustomKeysService } =
        await import("../../gateway/services/CustomKeysService.js");
      const service = getCustomKeysService();
      const existing = await service.getKeyByName(args.name);

      if (existing) {
        return {
          success: true,
          data: {
            name: args.name,
            status: "already_exists",
            message: `Key '${args.name}' already exists. Use \${${args.name}} in bash commands to reference it.`,
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Create key request that will show UI card
      // This is a special return format that the UI recognizes and renders as an input card
      return {
        success: true,
        data: {
          type: "key_request",
          name: args.name,
          description: args.description,
          sourceUrl: args.sourceUrl,
          requiredScopes: args.requiredScopes,
          suggestedPermission: args.permission,
          status: "awaiting_user_input",
          message: `Waiting for user to provide ${args.name}...`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

/**
 * All key management tools
 */
export const keyManagementTools = [
  listKeysTool,
  getKeyTool,
  setKeyTool,
  deleteKeyTool,
  requestKeyTool, // NEW
];
