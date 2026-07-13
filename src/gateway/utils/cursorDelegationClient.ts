/**
 * HTTP client for Papr memory server Cursor proxy (under /v1/ai/cursor).
 *
 * Security: Paprwork only sends PAPR_API_KEY. CURSOR_API_KEY never leaves
 * the memory server — @cursor/sdk runs server-side only.
 */

import type {
  CursorDelegationErrorResponse,
  CursorRunStreamEvent,
  CursorRunStreamRequest,
} from "../types/cursorDelegation.js";

function resolveCursorProxyBaseUrl(): string {
  if (process.env.PAPR_AI_PROXY_BASE_URL) {
    return process.env.PAPR_AI_PROXY_BASE_URL.replace(/\/$/, "");
  }

  const paprBase = process.env.PAPR_BASE_URL;
  if (paprBase) {
    return `${paprBase.replace(/\/$/, "")}/v1/ai`;
  }

  return "https://memory.papr.ai/v1/ai";
}

function parseErrorMessage(
  status: number,
  body: CursorDelegationErrorResponse | string,
): string {
  if (typeof body === "string") {
    return body || `Cursor proxy failed (${status})`;
  }
  return (
    body.detail ??
    body.message ??
    body.error ??
    `Cursor proxy failed (${status})`
  );
}

function parseSseDataLine(line: string): CursorRunStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(payload) as CursorRunStreamEvent;
  } catch {
    return { type: "text-delta", text: payload };
  }
}

export class CursorProxyClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? resolveCursorProxyBaseUrl()).replace(/\/$/, "");
  }

  /**
   * Stream a Cursor agent run from the memory server AI proxy.
   * Server runs @cursor/sdk with CURSOR_API_KEY — key never sent to Paprwork.
   */
  async *streamRun(
    paprApiKey: string,
    request: CursorRunStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<CursorRunStreamEvent> {
    const response = await fetch(`${this.baseUrl}/cursor/runs/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-API-Key": paprApiKey,
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      const rawText = await response.text();
      let parsed: CursorDelegationErrorResponse = {};
      if (rawText) {
        try {
          parsed = JSON.parse(rawText) as CursorDelegationErrorResponse;
        } catch {
          parsed = { detail: rawText };
        }
      }
      throw new Error(parseErrorMessage(response.status, parsed));
    }

    if (!response.body) {
      throw new Error("Cursor proxy returned empty response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseSseDataLine(line);
          if (event) {
            yield event;
          }
        }
      }

      if (buffer.trim()) {
        const event = parseSseDataLine(buffer);
        if (event) {
          yield event;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

let sharedClient: CursorProxyClient | undefined;

export function getCursorProxyClient(): CursorProxyClient {
  if (!sharedClient) {
    sharedClient = new CursorProxyClient();
  }
  return sharedClient;
}
