import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ChatMetadata } from "../../gateway/services/storage/IStorageProvider.js";
import { CURRENT_CHAT_SCOPE, resolveToolResultChatScope } from "./chatScope.js";

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
    .describe(
      "Where to search. Default 'current_chat' uses the active chat session. " +
      "Use 'all_chats' only when the toolCallId may be from another conversation.",
    ),
  chatId: z
    .string()
    .optional()
    .describe(
      `Optional chat scope (overrides searchIn). Pass "${CURRENT_CHAT_SCOPE}" for the active chat, ` +
      "or an explicit chat UUID.",
    ),
  startChar: z.number().int().min(0).optional().describe("Optional: Start character offset for partial read (0-based)"),
  length: z.number().int().min(1).max(100000).optional().describe("Optional: Number of characters to read (default: all remaining)"),
});

export const getFullToolResultTool = createTool({
  id: "get_full_tool_result",
  description:
    "Retrieve the FULL stored result for ONE tool call (by toolCallId) when context shows a truncation notice. " +
    "Default scope is the active chat. Use startChar/length to paginate very large results. " +
    "This reads the complete output from local storage — not a semantic search.",
  inputSchema: getFullToolResultSchema,
  execute: async (args) => {
    try {
      // Import dynamically to avoid circular dependencies
      const { getStorageManager } = await import("../../gateway/services/StorageManager.js");
      const storageManager = getStorageManager();
      const storage = storageManager.currentProvider;

      const scope = resolveToolResultChatScope({
        chatId: args.chatId,
        searchIn: args.searchIn,
      });
      if ("error" in scope) {
        return { success: false, error: scope.error };
      }

      let chatIds: string[];
      if (scope.mode === "single") {
        chatIds = [scope.chatId];
      } else {
        const allChats = await storage.listChats();
        chatIds = allChats.map((c: ChatMetadata) => c.id);
      }

      // Search for the tool call
      for (const chatId of chatIds) {
        const messages = await storage.loadMessages(chatId);
        
        // Search messages in reverse (most recent first)
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (!message.toolCalls) continue;

          interface ToolCallItem {
            id?: string;
            toolCallId?: string;
            name?: string;
            toolName?: string;
            result?: string | unknown;
          }

          const toolCall = message.toolCalls.find((tc: ToolCallItem) => {
            const storedId = tc.id ?? tc.toolCallId;
            const storedName = tc.name ?? tc.toolName;
            return (
              storedId === args.toolCallId &&
              (!args.toolName || storedName === args.toolName)
            );
          });

          if (toolCall) {
            const tc = toolCall as ToolCallItem;
            const storedName = tc.name ?? tc.toolName ?? args.toolName ?? "unknown";
            // Found it! Get the full result
            const fullResult = tc.result ?? "";
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
                  toolName: storedName,
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
                toolName: storedName,
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
        error:
          `Tool call ${args.toolCallId} not found in ` +
          `${scope.mode === "all" ? "any chat" : `chat ${chatIds[0]}`}. ` +
          "Try searchIn: 'all_chats' or pass the chatId from the truncation notice.",
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
