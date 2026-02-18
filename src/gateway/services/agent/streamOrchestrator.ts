import {
  sanitizeToolOutput,
  truncateResult,
} from "../../../core/tools/index.js";
import {
  createChatStreamChunk,
  parseToolCallChunk,
  parseToolErrorChunk,
  parseToolResultChunk,
  truncateStringsInUnknown,
  type ChatStreamChunk,
  type ToolCallEvent,
  type ToolResultEvent,
} from "./streamChunks.js";

export interface StreamOrchestratorResult {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  sequence: Array<{ type: 'text' | 'tool' | 'thinking'; data: any }>; // V1-style sequence for interleaving
}

export async function* orchestrateModelStream(
  fullStream: AsyncIterable<unknown>,
  chatId: string,
  apiKeys: string[],
): AsyncGenerator<ChatStreamChunk, StreamOrchestratorResult> {
  const TEXT_BUFFER_MIN = 50;
  let textBuffer = "";
  let reasoningBuffer = "";

  let assistantText = "";
  let thinkingText = "";
  const toolCalls: ToolCallEvent[] = [];
  const toolResults: ToolResultEvent[] = [];
  
  // Build V1-style sequence for interleaving text and tool calls
  const sequence: Array<{ type: 'text' | 'tool' | 'thinking'; data: any }> = [];
  let currentTextSegment = ""; // Accumulate text between tool calls

  for await (const rawChunk of fullStream) {
    if (typeof rawChunk !== "object" || rawChunk === null) {
      continue;
    }

    const chunk = rawChunk as { type?: unknown; text?: unknown; error?: unknown };
    const chunkType = chunk.type;
    if (chunkType !== "text-delta") {
      console.log(`[AgentService] Received chunk type: ${String(chunkType)}`);
    }

    switch (chunkType) {
      case "start-step": {
        // New step starts - if we have accumulated text, it belongs to previous step
        // We'll flush it when we see the tool-call for THIS step
        console.log("[StreamOrchestrator] Step starting...");
        break;
      }
      
      case "text-delta": {
        const text = typeof chunk.text === "string" ? chunk.text : "";
        assistantText += text;
        textBuffer += text;
        currentTextSegment += text; // Accumulate for sequence

        if (textBuffer.length >= TEXT_BUFFER_MIN) {
          yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
          textBuffer = "";
        }
        break;
      }
      
      case "text-end": {
        // Text for this step is complete - it will be followed by tool-call
        // Flush any remaining text buffer to ensure UI gets complete text before tool call
        if (textBuffer.length > 0) {
          console.log(`[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) at text-end`);
          yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
          textBuffer = "";
        }
        const trimmed = currentTextSegment.trim();
        if (trimmed) {
          console.log(`[StreamOrchestrator] Text segment complete (before tool): "${trimmed.substring(0, 50)}..."`);
        }
        break;
      }

      case "reasoning-start": {
        console.log("[AgentService] Reasoning started");
        // Flush text buffer before reasoning starts
        if (textBuffer.length > 0) {
          console.log(`[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) before reasoning`);
          yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
          textBuffer = "";
        }
        break;
      }

      case "reasoning-delta": {
        const reasoningText = typeof chunk.text === "string" ? chunk.text : "";
        thinkingText += reasoningText;
        reasoningBuffer += reasoningText;

        if (reasoningBuffer.length >= TEXT_BUFFER_MIN) {
          yield createChatStreamChunk(
            "reasoning-delta",
            { text: reasoningBuffer },
            chatId,
          );
          reasoningBuffer = "";
        }
        break;
      }

      case "reasoning-end": {
        console.log("[AgentService] Reasoning ended");
        if (reasoningBuffer.length > 0) {
          yield createChatStreamChunk(
            "reasoning-delta",
            { text: reasoningBuffer },
            chatId,
          );
          reasoningBuffer = "";
        }
        // Add thinking to sequence when complete
        if (thinkingText) {
          sequence.push({ type: 'thinking', data: thinkingText });
        }
        break;
      }

      case "tool-call": {
        const toolCall = parseToolCallChunk(rawChunk);
        if (!toolCall) break;

        toolCalls.push(toolCall);
        
        // CRITICAL: Flush text buffer to UI before tool call
        // This ensures all text before the tool call is sent to the UI first
        if (textBuffer.length > 0) {
          console.log(`[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) before tool call`);
          yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
          textBuffer = "";
        }
        
        // Flush accumulated text from this step's narration (comes before tool-call)
        if (currentTextSegment.trim()) {
          const trimmed = currentTextSegment.trim();
          console.log(`[StreamOrchestrator] Adding text to sequence (#${sequence.length + 1}): "${trimmed.substring(0, 50)}..."`);
          sequence.push({ type: 'text', data: trimmed });
          currentTextSegment = ""; // Reset for next step
        }
        
        // Add tool to sequence immediately (will update with result later)
        console.log(`[StreamOrchestrator] Adding tool to sequence (#${sequence.length + 1}): ${toolCall.toolName}`);
        sequence.push({
          type: 'tool',
          data: {
            name: toolCall.toolName,
            input: toolCall.args,
            status: 'calling', // Tool is running
            toolCallId: toolCall.toolCallId, // Keep for reliable result matching
          },
        });
        
        yield createChatStreamChunk(
          "tool-call",
          {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            args: toolCall.args,
          },
          chatId,
        );
        break;
      }

      case "tool-result": {
        const parsedToolResult = parseToolResultChunk(rawChunk);
        if (!parsedToolResult) break;

        const rawResult = parsedToolResult.result;
        let sanitizedResult = sanitizeToolOutput(rawResult, apiKeys);
        const rawSize =
          typeof rawResult === "string"
            ? rawResult.length
            : JSON.stringify(rawResult).length;
        console.log(
          `[AgentService] Tool ${parsedToolResult.toolName} raw result: ${rawSize} chars`,
        );

        if (typeof sanitizedResult === "string") {
          sanitizedResult = truncateResult(sanitizedResult);
        } else if (sanitizedResult && typeof sanitizedResult === "object") {
          sanitizedResult = truncateStringsInUnknown(sanitizedResult);
        }

        const toolResult: ToolResultEvent = {
          toolCallId: parsedToolResult.toolCallId,
          toolName: parsedToolResult.toolName,
          result: sanitizedResult,
        };
        toolResults.push(toolResult);
        
        // Update existing tool in sequence with result — match by toolCallId (reliable)
        const toolCall = toolCalls.find(tc => tc.toolCallId === toolResult.toolCallId);
        if (toolCall) {
          const toolIndex = sequence.findIndex(
            item => item.type === 'tool' &&
            (item.data as any).toolCallId === toolResult.toolCallId
          );
          
          if (toolIndex !== -1) {
            console.log(`[StreamOrchestrator] Updating tool in sequence at index ${toolIndex} with result`);
            sequence[toolIndex].data = {
              name: toolCall.toolName,
              input: toolCall.args,
              output: toolResult.result,
              status: 'success',
              toolCallId: toolResult.toolCallId, // Preserve for any future lookups
            };
          }
        }

        yield createChatStreamChunk(
          "tool-result",
          {
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            result: toolResult.result,
            success: true,
          },
          chatId,
        );
        break;
      }

      case "error": {
        const sanitizedError = sanitizeToolOutput(chunk.error, apiKeys);
        yield createChatStreamChunk(
          "error",
          { error: String(sanitizedError) },
          chatId,
        );
        break;
      }

      case "tool-error": {
        const toolError = parseToolErrorChunk(rawChunk);
        if (!toolError) break;

        const sanitizedError = sanitizeToolOutput(
          toolError.error || JSON.stringify(toolError),
          apiKeys,
        );
        console.error(
          `[AgentService] Tool error (${toolError.toolName || "unknown"}):`,
          sanitizedError,
        );

        yield createChatStreamChunk(
          "tool-error",
          {
            toolCallId: toolError.toolCallId,
            toolName: toolError.toolName || "unknown-tool",
            error: String(sanitizedError),
          },
          chatId,
        );
        break;
      }

      case "finish": {
        const finishReason = (rawChunk as any).finishReason;
        console.log(`[StreamOrchestrator] 🏁 Finish chunk received, reason: ${finishReason || 'unknown'}`);
        if (finishReason === 'length') {
          console.warn(`[StreamOrchestrator] ⚠️ Model stopped due to TOKEN LIMIT! Consider increasing maxTokens.`);
        }
        break;
      }
      default:
        break;
    }
  }

  if (textBuffer.length > 0) {
    yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
  }
  if (reasoningBuffer.length > 0) {
    yield createChatStreamChunk(
      "reasoning-delta",
      { text: reasoningBuffer },
      chatId,
    );
  }
  
  // Add any remaining text segment to sequence (final text after all tools)
  if (currentTextSegment.trim()) {
    sequence.push({ type: 'text', data: currentTextSegment.trim() });
  }

  return {
    assistantText,
    thinkingText,
    toolCalls,
    toolResults,
    sequence, // Return V1-style sequence for interleaving
  };
}
