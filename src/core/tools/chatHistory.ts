import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { CURRENT_CHAT_SCOPE, resolveToolResultChatScope } from "./chatScope.js";
import {
  findFullToolResult,
  sliceToolResult,
} from "../../gateway/services/agent/toolResultLookup.js";

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

/** Max chats scanned when searchIn is all_chats (most recently updated first). */
export const GET_FULL_TOOL_RESULT_ALL_CHATS_LIMIT = 20;

export const getFullToolResultTool = createTool({
  id: "get_full_tool_result",
  description:
    "Retrieve the FULL stored result for ONE tool call (by toolCallId) when context shows a truncation notice. " +
    "Default scope is the active chat. Use startChar/length to paginate very large results. " +
    "This reads the complete output from local storage — not a semantic search.",
  inputSchema: getFullToolResultSchema,
  execute: async (args) => {
    try {
      const { getStorageManager } = await import("../../gateway/services/StorageManager.js");
      const storage = getStorageManager().currentProvider;

      const scope = resolveToolResultChatScope({
        chatId: args.chatId,
        searchIn: args.searchIn,
      });
      if ("error" in scope) {
        return { success: false, error: scope.error };
      }

      let chatIds: string[];
      let allChatsScanNote: string | undefined;
      if (scope.mode === "single") {
        chatIds = [scope.chatId];
      } else {
        const allChats = await storage.listChats();
        const sorted = [...allChats].sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
        const limited = sorted.slice(0, GET_FULL_TOOL_RESULT_ALL_CHATS_LIMIT);
        chatIds = limited.map((c) => c.id);
        if (allChats.length > limited.length) {
          allChatsScanNote =
            `Searched ${limited.length} most recent chats (${allChats.length} total). ` +
            "Pass an explicit chatId if the tool call is from an older conversation.";
        }
      }

      const match = await findFullToolResult({
        chatIds,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        loadMessages: (chatId) => storage.loadMessages(chatId),
      });

      if (!match) {
        return {
          success: false,
          error:
            `Tool call ${args.toolCallId} not found in ` +
            `${scope.mode === "all" ? "recent chats" : `chat ${chatIds[0]}`}. ` +
            (allChatsScanNote ? `${allChatsScanNote} ` : "") +
            "Results from the current turn may still be persisting — retry in a few seconds, " +
            "or pass an explicit chatId if the truncation notice came from another chat.",
        };
      }

      const sliced = sliceToolResult(match.result, args.startChar, args.length);

      if (args.startChar !== undefined) {
        return {
          success: true,
          data: {
            toolName: match.toolName,
            toolCallId: args.toolCallId,
            messageId: match.messageId,
            chatId: match.chatId,
            totalLength: match.result.length,
            ...(allChatsScanNote ? { scanNote: allChatsScanNote } : {}),
            ...sliced,
          },
        };
      }

      return {
        success: true,
        data: {
          toolName: match.toolName,
          toolCallId: args.toolCallId,
          messageId: match.messageId,
          chatId: match.chatId,
          totalLength: match.result.length,
          ...(allChatsScanNote ? { scanNote: allChatsScanNote } : {}),
          result: sliced.result,
        },
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
