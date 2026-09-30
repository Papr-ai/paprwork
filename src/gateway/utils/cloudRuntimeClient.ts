/**
 * HTTP client for Papr cloud runtime (POST /v1/cloud/runtime/*).
 */

import type {
  CloudRuntimeErrorResponse,
  CloudRuntimeStreamEvent,
  CloudRuntimeStreamRequest,
  DesktopHeartbeatResponse,
} from "../types/cloudRuntime.js";
import { cloudApiFetch, getMemoryServerBaseUrl } from "./cloudApiClient.js";
import { cloudActingUserFields } from "./cloudActingUser.js";

function parseErrorMessage(
  status: number,
  body: CloudRuntimeErrorResponse | string,
): string {
  if (typeof body === "string") {
    return body || `Cloud runtime failed (${status})`;
  }
  return (
    body.detail ??
    body.message ??
    body.error ??
    `Cloud runtime failed (${status})`
  );
}

function parseSseDataLine(line: string): CloudRuntimeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(payload) as CloudRuntimeStreamEvent;
  } catch {
    return { type: "text-delta", text: payload };
  }
}

export class CloudRuntimeClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? `${getMemoryServerBaseUrl()}/v1/cloud/runtime`).replace(
      /\/$/,
      "",
    );
  }

  async *streamSession(
    paprApiKey: string,
    request: CloudRuntimeStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<CloudRuntimeStreamEvent> {
    const response = await fetch(`${this.baseUrl}/sessions/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-API-Key": paprApiKey,
      },
      body: JSON.stringify({
        chatId: request.chatId,
        prompt: request.prompt,
        provider: request.provider,
        model: request.model,
        agentId: request.agentId,
        tier: request.tier ?? "sandbox",
        runtime: request.runtime ?? "cloud",
        ...cloudActingUserFields(),
      }),
      signal,
    });

    if (!response.ok) {
      const rawText = await response.text();
      let parsed: CloudRuntimeErrorResponse = {};
      if (rawText) {
        try {
          parsed = JSON.parse(rawText) as CloudRuntimeErrorResponse;
        } catch {
          parsed = { detail: rawText };
        }
      }
      throw new Error(parseErrorMessage(response.status, parsed));
    }

    if (!response.body) {
      throw new Error("Cloud runtime returned empty response body");
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

  async sendDesktopHeartbeat(
    _paprApiKey: string,
    _signal?: AbortSignal,
  ): Promise<DesktopHeartbeatResponse> {
    const response = await cloudApiFetch("/v1/cloud/runtime/heartbeat", {
      method: "POST",
      body: {},
      timeoutMs: 15_000,
    });

    if (!response.ok) {
      const rawText = await response.text();
      throw new Error(
        rawText.slice(0, 200) || `Desktop heartbeat failed (${response.status})`,
      );
    }

    return (await response.json()) as DesktopHeartbeatResponse;
  }
}

let sharedClient: CloudRuntimeClient | undefined;

export function getCloudRuntimeClient(): CloudRuntimeClient {
  if (!sharedClient) {
    sharedClient = new CloudRuntimeClient();
  }
  return sharedClient;
}
