import Papr from "@papr/memory";
import { getApiKey } from "../../utils/keyResolver.js";
import { paprMemoryScopeSpread } from "../../utils/memoryScopeResolver.js";
import {
  CAPTURE_CONTENT_TYPE,
  CAPTURE_SOURCE,
  MAX_MEMORY_BODY_CHARS,
} from "./constants.js";
import {
  formatCaptureMemoryBody,
  type CaptureEvaluationResult,
} from "./evaluation.js";
import type { ToolCaptureRow } from "./ToolCaptureLedger.js";
import { getToolCaptureLedger } from "./ToolCaptureLedger.js";

function parseKeysUsed(keysUsedJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(keysUsedJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function extractMemoryId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const record = response as Record<string, unknown>;
  if (typeof record.id === "string") {
    return record.id;
  }
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (typeof data.id === "string") {
      return data.id;
    }
    if (typeof data.memory_id === "string") {
      return data.memory_id;
    }
  }
  return undefined;
}

export async function syncToolCaptureToMemory(row: ToolCaptureRow): Promise<void> {
  const apiKey = await getApiKey("PAPR_API_KEY");
  if (!apiKey) {
    getToolCaptureLedger().markFailed(row.id, "no_api_key");
    return;
  }

  const keysUsed = parseKeysUsed(row.keys_used);
  const evaluation: CaptureEvaluationResult = {
    keysUsed,
    inferredLabel: row.inferred_label,
    contentDate: row.content_date,
    stableEntityId: undefined,
    dedupKey: row.dedup_key,
    contentHash: row.content_hash,
    inferredSubject: row.inferred_subject ?? undefined,
  };

  const content = formatCaptureMemoryBody(
    evaluation,
    row.body,
    row.chat_id,
    MAX_MEMORY_BODY_CHARS,
  );

  const client = new Papr({
    xAPIKey: apiKey,
    maxRetries: 2,
    timeout: 30000,
  });

  try {
    const memoryScope = await paprMemoryScopeSpread({ chatId: row.chat_id });
    const response = await client.memory.add({
      content,
      ...memoryScope,
      metadata: {
        role: "assistant",
        category: "fact",
        customMetadata: {
          source: CAPTURE_SOURCE,
          content_type: CAPTURE_CONTENT_TYPE,
          tool_name: row.tool_name,
          chat_id: row.chat_id,
          keys_used: keysUsed.join(","),
          inferred_label: row.inferred_label,
          content_date: row.content_date,
          dedup_key: row.dedup_key,
          content_hash: row.content_hash,
          capture_id: row.id,
          ...(row.inferred_subject
            ? { inferred_subject: row.inferred_subject }
            : {}),
          ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
        },
      },
    });

    const memoryId = extractMemoryId(response);
    if (!memoryId) {
      getToolCaptureLedger().markFailed(row.id, "memory_add_missing_id");
      return;
    }

    getToolCaptureLedger().markSynced(row.id, memoryId);
    console.log(
      `[ToolCapture] Synced capture ${row.id} to Papr Memory (${memoryId}) — keys: ${keysUsed.join(", ")}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getToolCaptureLedger().markFailed(row.id, message);
    console.warn(`[ToolCapture] Memory sync failed for ${row.id}:`, message);
  }
}
