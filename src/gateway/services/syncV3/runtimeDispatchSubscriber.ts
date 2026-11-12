/**
 * SSE subscriber for cloud job runtime patches (Phase 4b).
 * Replaces 60s heartbeat poll latency when SYNC_V3_DISPATCH_PUSH is enabled.
 */

import type { JobRuntimePatch } from "../../types/cloudRuntime.js";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { getPaprApiKey } from "../../utils/keyResolver.js";
import { isSyncV3FlagEnabled } from "./syncV3Flags.js";

/** "Database X changed" push from memory (fast path; the heartbeat index check stays as the safety net). */
export interface DbChangedEvent {
  shortName: string;
  dbId?: string;
  jobId?: string;
  tables?: string[];
}

export interface RuntimeDispatchSubscriberOptions {
  onPatch: (patch: JobRuntimePatch) => Promise<void>;
  onDbChanged?: (event: DbChangedEvent) => void;
  onError?: (message: string) => void;
}

let activeAbort: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export type DispatchMessage =
  | { kind: "patch"; patch: JobRuntimePatch }
  | { kind: "db_changed"; event: DbChangedEvent };

export function parseSseDataBlock(block: string): DispatchMessage | null {
  for (const line of block.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line.slice(6)) as {
        type?: string;
        patch?: JobRuntimePatch;
      } & Partial<DbChangedEvent>;
      if (parsed.type === "job_runtime_patch" && parsed.patch?.jobId) {
        return { kind: "patch", patch: parsed.patch };
      }
      if (parsed.type === "db_changed" && parsed.shortName) {
        const { shortName, dbId, jobId, tables } = parsed;
        return { kind: "db_changed", event: { shortName, dbId, jobId, tables } };
      }
    } catch {
      /* ignore malformed event */
    }
  }
  return null;
}

async function consumeDispatchStream(
  options: RuntimeDispatchSubscriberOptions,
  signal: AbortSignal,
): Promise<void> {
  const res = await cloudApiFetch("/v1/cloud/runtime/dispatch/stream", {
    method: "GET",
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`dispatch stream failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const block of parts) {
      const message = parseSseDataBlock(block);
      if (message?.kind === "patch") {
        await options.onPatch(message.patch);
      } else if (message?.kind === "db_changed") {
        options.onDbChanged?.(message.event);
      }
    }
  }
}

export function stopRuntimeDispatchSubscriber(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  activeAbort?.abort();
  activeAbort = null;
}

export function startRuntimeDispatchSubscriber(
  options: RuntimeDispatchSubscriberOptions,
): void {
  if (!isSyncV3FlagEnabled("SYNC_V3_DISPATCH_PUSH")) {
    return;
  }

  stopRuntimeDispatchSubscriber();

  const connect = async (): Promise<void> => {
    const apiKey = await getPaprApiKey();
    if (!apiKey) {
      scheduleReconnect();
      return;
    }

    const abort = new AbortController();
    activeAbort = abort;

    try {
      await consumeDispatchStream(options, abort.signal);
      if (!abort.signal.aborted) {
        scheduleReconnect();
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        options.onError?.((err as Error).message.slice(0, 120));
        scheduleReconnect();
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 5_000);
  };

  void connect();
  console.log("[RuntimeDispatch] SSE subscriber started");
}
