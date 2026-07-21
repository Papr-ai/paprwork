/**
 * Parse SSE bodies from memory-server app-agent stream (gateway proxy or app-agent events).
 */

import type { GatewayStreamRawEvent } from "./mapGatewayStreamToAppAgentEvents.js";

export async function* parseRuntimeSseStream(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<GatewayStreamRawEvent> {
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];

  const flush = (): GatewayStreamRawEvent | null => {
    if (dataLines.length === 0) {
      return null;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    try {
      const parsed = JSON.parse(raw) as GatewayStreamRawEvent;
      if (typeof parsed.type !== "string" && eventType !== "message") {
        parsed.type = eventType;
      }
      if (eventType.startsWith("app-agent:") && parsed.data === undefined) {
        const { type: _ignored, ...rest } = parsed;
        parsed.type = eventType;
        parsed.data = rest;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        const pending = flush();
        if (pending) {
          yield pending;
        }
        eventType = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
        continue;
      }
      if (line.trim() === "" && dataLines.length > 0) {
        const pending = flush();
        if (pending) {
          yield pending;
        }
      }
    }
  }

  const pending = flush();
  if (pending) {
    yield pending;
  }
}
