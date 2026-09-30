/**
 * Module-level streaming refs — survive ChatContainer unmount so chunks keep
 * updating the store when the user switches tabs mid-turn.
 */

import type { ToolCall } from "../types/core";
import type { SequenceItem } from "../types/chat";
import type { StreamingRefs } from "./agentStreamRecovery";

export const agentStreamingMessageIdRef = new Map<string, string>();
export const agentStreamingContentRef = new Map<string, string>();
export const agentStreamingReasoningRef = new Map<string, string>();
export const agentToolCallsMapRef = new Map<string, Map<string, ToolCall>>();
export const agentSequenceRef = new Map<
  string,
  Array<{ type: "text" | "tool" | "thinking"; data: unknown }>
>();
export const agentCurrentTextSegmentRef = new Map<string, string>();

export function getAgentStreamingRefs(): StreamingRefs {
  return {
    streamingMessageIdRef: { current: agentStreamingMessageIdRef },
    streamingContentRef: { current: agentStreamingContentRef },
    streamingReasoningRef: { current: agentStreamingReasoningRef },
    toolCallsMapRef: { current: agentToolCallsMapRef },
    sequenceRef: { current: agentSequenceRef },
    currentTextSegmentRef: { current: agentCurrentTextSegmentRef },
  };
}

export function resetAgentStreamingRefsForChat(chatId: string): void {
  agentStreamingMessageIdRef.delete(chatId);
  agentStreamingContentRef.delete(chatId);
  agentStreamingReasoningRef.delete(chatId);
  agentToolCallsMapRef.delete(chatId);
  agentSequenceRef.delete(chatId);
  agentCurrentTextSegmentRef.delete(chatId);
}
