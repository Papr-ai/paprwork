/**
 * Map Cloud Agent Gateway / cloud-runtime SSE events → app-agent chat SSE events.
 */

import type { AppAgentChatSseEvent } from "../../../core/types/appAgentChat.js";
import type {
  ErrorPayload,
  ReasoningDeltaPayload,
  TextDeltaPayload,
  ToolCallPayload,
  ToolErrorPayload,
  ToolResultPayload,
} from "../../../core/types/streaming.js";
import type { CloudRuntimeStreamEvent } from "../../types/cloudRuntime.js";

export type GatewayStreamRawEvent = Record<string, unknown>;

const APP_AGENT_EVENT_PREFIX = "app-agent:";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mapStreamChunkToAppAgentEvents(
  chunk: { type: string; payload: unknown },
  turnId: string,
): AppAgentChatSseEvent[] {
  if (chunk.type === "reasoning-delta") {
    const payload = chunk.payload as ReasoningDeltaPayload;
    if (typeof payload.text !== "string" || payload.text.length === 0) {
      return [];
    }
    return [
      {
        type: "app-agent:thinking-delta",
        data: { turnId, text: payload.text },
      },
    ];
  }
  if (chunk.type === "text-delta") {
    const payload = chunk.payload as TextDeltaPayload;
    if (typeof payload.text !== "string" || payload.text.length === 0) {
      return [];
    }
    return [
      {
        type: "app-agent:text-delta",
        data: { turnId, text: payload.text },
      },
    ];
  }
  if (chunk.type === "tool-call") {
    const payload = chunk.payload as ToolCallPayload;
    return [
      {
        type: "app-agent:tool-call",
        data: {
          turnId,
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          args: payload.args,
        },
      },
    ];
  }
  if (chunk.type === "tool-call-delta") {
    return [
      {
        type: "app-agent:status",
        data: { turnId, message: "Preparing tool call…" },
      },
    ];
  }
  if (chunk.type === "compression-start") {
    return [
      {
        type: "app-agent:status",
        data: { turnId, message: "Compressing context…" },
      },
    ];
  }
  if (chunk.type === "wrap-up-start") {
    return [
      {
        type: "app-agent:status",
        data: { turnId, message: "Summarizing progress…" },
      },
    ];
  }
  if (chunk.type === "tool-result") {
    const payload = chunk.payload as ToolResultPayload;
    return [
      {
        type: "app-agent:tool-result",
        data: {
          turnId,
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          result: payload.result,
        },
      },
    ];
  }
  if (chunk.type === "tool-error") {
    const payload = chunk.payload as ToolErrorPayload;
    return [
      {
        type: "app-agent:tool-error",
        data: {
          turnId,
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          error: payload.error,
        },
      },
    ];
  }
  if (chunk.type === "error") {
    const payload = chunk.payload as ErrorPayload;
    const error =
      typeof payload.error === "string"
        ? payload.error
        : JSON.stringify(payload.error);
    return [{ type: "app-agent:error", data: { turnId, error } }];
  }
  return [];
}

function mapCloudRuntimeEventToAppAgent(
  event: CloudRuntimeStreamEvent,
  turnId: string,
): AppAgentChatSseEvent[] {
  if (
    event.type === "reasoning-delta" &&
    typeof event.text === "string" &&
    event.text.length > 0
  ) {
    return [{ type: "app-agent:thinking-delta", data: { turnId, text: event.text } }];
  }
  if (event.type === "text-delta" && typeof event.text === "string" && event.text.length > 0) {
    return [{ type: "app-agent:text-delta", data: { turnId, text: event.text } }];
  }
  if (event.type === "tool-call") {
    return [
      {
        type: "app-agent:tool-call",
        data: {
          turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
      },
    ];
  }
  if (event.type === "tool-result") {
    return [
      {
        type: "app-agent:tool-result",
        data: {
          turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
        },
      },
    ];
  }
  if (event.type === "error") {
    const error =
      event.message ??
      event.error ??
      (typeof event.text === "string" ? event.text : "App assistant stream failed");
    return [{ type: "app-agent:error", data: { turnId, error } }];
  }
  return [];
}

/** Convert one raw SSE JSON object (gateway, cloud-runtime, or app-agent) into app-agent events. */
export function mapGatewayStreamToAppAgentEvents(
  raw: GatewayStreamRawEvent,
  turnId: string,
): AppAgentChatSseEvent[] {
  const type = typeof raw.type === "string" ? raw.type : "";

  if (type.startsWith(APP_AGENT_EVENT_PREFIX)) {
    const data = asRecord(raw.data);
    return [
      {
        type: type as AppAgentChatSseEvent["type"],
        data: { ...data, turnId },
      },
    ];
  }

  if (type === "error" && typeof raw.message === "string") {
    return [{ type: "app-agent:error", data: { turnId, error: raw.message } }];
  }

  if (raw.payload !== undefined) {
    return mapStreamChunkToAppAgentEvents({ type, payload: raw.payload }, turnId);
  }

  return mapCloudRuntimeEventToAppAgent(raw as unknown as CloudRuntimeStreamEvent, turnId);
}
