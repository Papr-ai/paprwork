import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ChatMetadata } from "../../gateway/services/storage/IStorageProvider.js";

/**
 * Chat History Tools
 * 
 * Tools for accessing full tool results when they've been truncated in context.
 * This allows agents to "dig deeper" into large tool outputs without loading
 * everything into context upfront.
 */

const getFullToolResultSchema = z.object({
  toolCallId: z.string().min(1).describe("The tool call ID (from truncation notice)"),
  toolName: z.string().optional().describe("The tool name (optional, helps narrow search)"),
  searchIn: z.enum(["current_chat", "all_chats"]).optional().default("current_chat")
    .describe("Where to search: 'current_chat' (default) or 'all_chats'"),
  chatId: z.string().optional().describe("Optional: Specific chat ID to search (overrides searchIn)"),
  startChar: z.number().int().min(0).optional().describe("Optional: Start character offset for partial read (0-based)"),
  length: z.number().int().min(1).max(100000).optional().describe("Optional: Number of characters to read (default: all remaining)"),
});

export const getFullToolResultTool = createTool({
  id: "get_full_tool_result",
  description:
    "Retrieve the full result of a tool call that was truncated in context. " +
    "Use this when you see '[... X chars truncated ... Full result available via: get_full_tool_result(...)]' " +
    "in a tool result. Searches current chat by toolCallId. You can read the entire result or just a specific section using startChar/length.",
  inputSchema: getFullToolResultSchema,
  execute: async (args) => {
    try {
      // Import dynamically to avoid circular dependencies
      const { getStorageManager } = await import("../../gateway/services/StorageManager.js");
      const storageManager = getStorageManager();
      const storage = storageManager.currentProvider;

      // Determine which chats to search
      let chatIds: string[];
      if (args.chatId) {
        chatIds = [args.chatId];
      } else if (args.searchIn === "all_chats") {
        const allChats = await storage.listChats();
        chatIds = allChats.map((c: ChatMetadata) => c.id);
      } else {
        // Search current chat - we need to get this from somewhere
        // For now, search all chats but prioritize recent
        const allChats = await storage.listChats();
        chatIds = allChats
          .sort((a: ChatMetadata, b: ChatMetadata) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
          .slice(0, 5) // Search last 5 chats
          .map((c: ChatMetadata) => c.id);
      }

      // Search for the tool call
      for (const chatId of chatIds) {
        const messages = await storage.loadMessages(chatId);
        
        // Search messages in reverse (most recent first)
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (!message.toolCalls) continue;

          // Find matching tool call
          interface ToolCallItem {
            id: string;
            name: string;
            result?: string | unknown;
          }
          const toolCall = message.toolCalls.find((tc: ToolCallItem) => 
            tc.id === args.toolCallId && 
            (!args.toolName || tc.name === args.toolName)
          );

          if (toolCall) {
            // Found it! Get the full result
            const fullResult = toolCall.result ?? "";
            const resultStr = typeof fullResult === "string" 
              ? fullResult 
              : JSON.stringify(fullResult, null, 2);

            // If partial read requested, slice the result
            if (args.startChar !== undefined) {
              const start = args.startChar;
              const end = args.length ? start + args.length : undefined;
              const sliced = resultStr.substring(start, end);
              
              return {
                success: true,
                data: {
                  toolName: toolCall.name,
                  toolCallId: args.toolCallId,
                  messageId: message.id,
                  chatId: chatId,
                  totalLength: resultStr.length,
                  startChar: start,
                  endChar: end ?? resultStr.length,
                  lengthReturned: sliced.length,
                  result: sliced,
                  hasMore: end !== undefined && end < resultStr.length,
                  nextStartChar: end,
                },
              };
            }

            // Return full result
            return {
              success: true,
              data: {
                toolName: toolCall.name,
                toolCallId: args.toolCallId,
                messageId: message.id,
                chatId: chatId,
                totalLength: resultStr.length,
                result: resultStr,
              },
            };
          }
        }
      }

      // Not found
      return {
        success: false,
        error: `Tool call ${args.toolCallId} not found in ${args.searchIn === "all_chats" ? "any chat" : "current/recent chats"}. ` +
               `Try specifying a chatId if you know which chat contains this result.`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const chatHistoryTools = [getFullToolResultTool];
