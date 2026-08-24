/**
 * Message payload store — keeps oversized tool payloads out of SQLite rows.
 *
 * An assistant turn used to write the same tool payloads twice: once into
 * `messages.tool_calls` and again into `messages.sequence`. With a few large
 * results (file reads, scrapes, delegation transcripts) a single row grew past
 * 100MB, and loading that chat parsed every copy into the heap — which is how
 * the gateway hit V8's 4GB ceiling and aborted.
 *
 * On disk we now keep one copy of each payload:
 *   - `tool_calls` stays canonical (LLM context, analytics and sync read it)
 *   - `sequence` keeps ordering metadata plus a pointer back to `tool_calls`
 *   - results above OFFLOAD_THRESHOLD_CHARS move to a sidecar file
 *
 * Reads rehydrate the pointers, so a `StoredMessage` looks exactly as it did
 * before. Nothing is discarded: an offloaded result keeps an inline preview and
 * the full text stays on disk, retrievable via `get_full_tool_result`.
 *
 * This module decides what to slim and what to offload; `toolResultSidecars.ts`
 * owns the sidecar file layout and size budgets, and is re-exported here so
 * callers have a single entry point.
 */

import type { StoredMessage } from "./IStorageProvider.js";
import {
  buildOffloadStub,
  COMPACT_PREVIEW_CHARS,
  MAX_ROW_PAYLOAD_CHARS,
  MIN_SPILL_CHARS,
  offloadResult,
  OFFLOAD_PREVIEW_CHARS,
  OFFLOAD_THRESHOLD_CHARS,
  type OffloadedResultRef,
} from "./toolResultSidecars.js";

// The sidecar layout and budgets live in toolResultSidecars.ts; re-exported here
// so callers have one entry point for message payload storage.
export {
  buildOffloadStub,
  COMPACT_PREVIEW_CHARS,
  deleteChatSidecars,
  MAX_ROW_PAYLOAD_CHARS,
  MIN_SPILL_CHARS,
  OFFLOAD_PREVIEW_CHARS,
  OFFLOAD_THRESHOLD_CHARS,
  readOffloadedResult,
  SIDECAR_DIRNAME,
  type OffloadedResultRef,
} from "./toolResultSidecars.js";

/**
 * Largest single column we are willing to pull into JS and parse. Rows written
 * before offloading existed can be hundreds of megabytes, and parsing one was
 * enough to exhaust the heap, so the read path skips them instead.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * SQL that yields NULL instead of a payload too large to pull into the heap.
 * Use it anywhere a query fetches a payload column it intends to parse.
 */
export function boundedPayloadSql(column: "tool_calls" | "sequence"): string {
  return (
    `CASE WHEN LENGTH(${column}) > ${MAX_INLINE_PAYLOAD_BYTES} ` +
    `THEN NULL ELSE ${column} END AS ${column}`
  );
}

type ToolCallRecord = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  status?: string;
  resultOffload?: OffloadedResultRef;
  [key: string]: unknown;
};

type SequenceItem = {
  type: "text" | "tool" | "thinking";
  data: string | Record<string, unknown>;
};

/** Marks how a slimmed sequence item rebuilds its payload from `tool_calls`. */
const INPUT_REF = "toolCall";
const OUTPUT_REF_STRING = "toolCall:string";
const OUTPUT_REF_JSON = "toolCall:json";

function isToolItem(
  item: SequenceItem,
): item is { type: "tool"; data: Record<string, unknown> } {
  return (
    item?.type === "tool" &&
    typeof item.data === "object" &&
    item.data !== null &&
    !Array.isArray(item.data)
  );
}

/**
 * Shrink a message's payloads for storage: offload oversized results and drop
 * the copies that `sequence` duplicates from `tool_calls`.
 *
 * The input message is never mutated — callers still sync the full-fidelity
 * object to Papr and hand it to exporters after saving.
 */
export function serializeMessagePayloads(args: {
  dbDir: string;
  chatId: string;
  messageId: string;
  message: StoredMessage;
}): { toolCallsJson: string | null; sequenceJson: string | null } {
  const { dbDir, chatId, messageId, message } = args;

  const toolCalls = message.toolCalls
    ? (message.toolCalls.map((tc) => ({ ...tc })) as ToolCallRecord[])
    : undefined;

  // Offload oversized results, keeping a preview plus a pointer inline.
  const byId = new Map<string, ToolCallRecord>();
  for (const tc of toolCalls ?? []) {
    const toolCallId = typeof tc.id === "string" ? tc.id : undefined;
    if (toolCallId) {
      byId.set(toolCallId, tc);
    }

    if (
      typeof tc.result !== "string" ||
      tc.result.length <= OFFLOAD_THRESHOLD_CHARS ||
      !toolCallId
    ) {
      continue;
    }

    const ref = offloadResult({
      dbDir,
      chatId,
      messageId,
      toolCallId,
      result: tc.result,
    });
    if (!ref) continue;

    tc.result = buildOffloadStub({
      payload: tc.result,
      previewChars: OFFLOAD_PREVIEW_CHARS,
      toolCallId,
      toolName: typeof tc.name === "string" ? tc.name : undefined,
    });
    tc.resultOffload = ref;
  }

  spillLargestUntilRowFits({ dbDir, chatId, messageId, toolCalls });

  // Replace the duplicated sequence payloads with pointers into tool_calls.
  const sequence = message.sequence as SequenceItem[] | undefined;
  const slimmedSequence = sequence?.map((item, index) => {
    if (!isToolItem(item)) return item;

    const data = { ...item.data };
    const toolCallId =
      typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    const twin = toolCallId ? byId.get(toolCallId) : undefined;

    if (!twin) {
      return { ...item, data: offloadOrphanPayload({ dbDir, chatId, messageId, index, data }) };
    }

    if (data.input !== undefined && twin.args !== undefined) {
      delete data.input;
      data.inputRef = INPUT_REF;
    }

    // `tool_calls` holds the JSON-stringified form of the same value, so the
    // pointer only records which shape to rebuild. `null` stays inline: it
    // serializes to nothing in `tool_calls`, so it could not be restored.
    if (
      data.output !== undefined &&
      data.output !== null &&
      typeof twin.result === "string"
    ) {
      const wasString = typeof data.output === "string";
      delete data.output;
      data.outputRef = wasString ? OUTPUT_REF_STRING : OUTPUT_REF_JSON;
    }

    return { ...item, data };
  });

  return {
    toolCallsJson: toolCalls?.length ? JSON.stringify(toolCalls) : null,
    sequenceJson: slimmedSequence?.length
      ? JSON.stringify(slimmedSequence)
      : null,
  };
}

/**
 * Bring the row under budget, in two passes.
 *
 * First spill the largest results that are still fully inline. Once everything
 * worth a sidecar has one, the row can still be over budget purely from
 * previews (40K each adds up), so the second pass shrinks those previews to
 * COMPACT_PREVIEW_CHARS, largest first. Mutates the records in place.
 */
function spillLargestUntilRowFits(args: {
  dbDir: string;
  chatId: string;
  messageId: string;
  toolCalls: ToolCallRecord[] | undefined;
}): void {
  const { toolCalls } = args;
  if (!toolCalls?.length) return;

  const rowSize = () =>
    toolCalls.reduce(
      (sum, tc) => sum + (typeof tc.result === "string" ? tc.result.length : 0),
      0,
    );

  while (rowSize() > MAX_ROW_PAYLOAD_CHARS) {
    let largest: ToolCallRecord | undefined;
    for (const tc of toolCalls) {
      if (tc.resultOffload || typeof tc.result !== "string") continue;
      if (tc.result.length < MIN_SPILL_CHARS) continue;
      if (!largest || tc.result.length > (largest.result as string).length) {
        largest = tc;
      }
    }
    if (!largest || typeof largest.id !== "string") break;

    const ref = offloadResult({
      dbDir: args.dbDir,
      chatId: args.chatId,
      messageId: args.messageId,
      toolCallId: largest.id,
      result: largest.result as string,
    });
    if (!ref) break;

    largest.result = buildOffloadStub({
      payload: largest.result as string,
      previewChars: OFFLOAD_PREVIEW_CHARS,
      toolCallId: largest.id,
      toolName: typeof largest.name === "string" ? largest.name : undefined,
    });
    largest.resultOffload = ref;
  }

  shrinkPreviewsUntilRowFits(toolCalls, rowSize);
}

/**
 * Last resort once every spillable result already has a sidecar: re-cut the
 * largest previews down to COMPACT_PREVIEW_CHARS. The full payload is already
 * safe on disk, so this only trades inline fidelity for a bounded row.
 */
function shrinkPreviewsUntilRowFits(
  toolCalls: ToolCallRecord[],
  rowSize: () => number,
): void {
  while (rowSize() > MAX_ROW_PAYLOAD_CHARS) {
    let largest: ToolCallRecord | undefined;
    let largestRef: OffloadedResultRef | undefined;
    for (const tc of toolCalls) {
      const ref = tc.resultOffload;
      if (!ref || typeof tc.result !== "string") continue;
      if (tc.result.length <= COMPACT_PREVIEW_CHARS) continue;
      if (!largest || tc.result.length > (largest.result as string).length) {
        largest = tc;
        largestRef = ref;
      }
    }
    if (!largest || !largestRef || typeof largest.id !== "string") return;

    // The existing preview starts with the payload's own head, so re-slicing it
    // yields the same bytes a shorter preview would have taken originally. The
    // true total comes from the ref, not from the preview we are slicing.
    largest.result = buildOffloadStub({
      payload: (largest.result as string).slice(0, COMPACT_PREVIEW_CHARS),
      previewChars: COMPACT_PREVIEW_CHARS,
      totalChars: largestRef.totalChars,
      toolCallId: largest.id,
      toolName: typeof largest.name === "string" ? largest.name : undefined,
    });
  }
}

/**
 * A sequence tool item with no twin in `tool_calls` cannot point anywhere, so
 * offload its payload directly rather than leaving a giant row behind.
 */
function offloadOrphanPayload(args: {
  dbDir: string;
  chatId: string;
  messageId: string;
  index: number;
  data: Record<string, unknown>;
}): Record<string, unknown> {
  const { data } = args;
  const output = data.output;
  const serialized =
    typeof output === "string"
      ? output
      : output === undefined || output === null
        ? undefined
        : safeStringify(output);

  if (!serialized || serialized.length <= OFFLOAD_THRESHOLD_CHARS) {
    return data;
  }

  const toolCallId =
    typeof data.toolCallId === "string"
      ? data.toolCallId
      : `sequence-${args.index}`;

  const ref = offloadResult({
    dbDir: args.dbDir,
    chatId: args.chatId,
    messageId: args.messageId,
    toolCallId: `orphan-${toolCallId}`,
    result: serialized,
  });
  if (!ref) return data;

  return {
    ...data,
    output: buildOffloadStub({
      payload: serialized,
      previewChars: OFFLOAD_PREVIEW_CHARS,
      toolCallId,
      toolName: typeof data.name === "string" ? data.name : undefined,
    }),
    outputOffload: ref,
  };
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Rebuild the sequence payloads that `serializeMessagePayloads` pointed at
 * `tool_calls`, so consumers see the shape they always have.
 *
 * Strings are shared by reference, so restoring costs no extra memory.
 */
export function restoreSequencePayloads(
  sequence: SequenceItem[] | undefined,
  toolCalls: ToolCallRecord[] | undefined,
): SequenceItem[] | undefined {
  if (!sequence?.length) return sequence;

  const byId = new Map<string, ToolCallRecord>();
  for (const tc of toolCalls ?? []) {
    if (typeof tc.id === "string") byId.set(tc.id, tc);
  }

  return sequence.map((item) => {
    if (!isToolItem(item)) return item;

    const { inputRef, outputRef, ...data } = item.data as Record<
      string,
      unknown
    >;
    if (inputRef === undefined && outputRef === undefined) return item;

    const toolCallId =
      typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    const twin = toolCallId ? byId.get(toolCallId) : undefined;

    if (inputRef === INPUT_REF) {
      data.input = twin?.args;
    }

    if (outputRef === OUTPUT_REF_STRING || outputRef === OUTPUT_REF_JSON) {
      const stored = twin?.result;
      if (outputRef === OUTPUT_REF_JSON && typeof stored === "string") {
        // An offloaded twin only holds a preview, which will not parse — fall
        // back to the preview text so the pointer stays visible.
        try {
          data.output = JSON.parse(stored);
        } catch {
          data.output = stored;
        }
      } else {
        data.output = stored;
      }
    }

    return { ...item, data };
  });
}

/** Find the offload pointer for one tool call, if it has one. */
export function findOffloadRef(
  message: StoredMessage,
  toolCallId: string,
): OffloadedResultRef | null {
  for (const tc of (message.toolCalls ?? []) as ToolCallRecord[]) {
    if (tc.id === toolCallId && tc.resultOffload?.file) {
      return tc.resultOffload;
    }
  }
  return null;
}

/**
 * Placeholder used when a legacy row is too large to parse safely.
 * Keeps the turn visible instead of risking the heap on a single row.
 */
export function oversizedPayloadPlaceholder(args: {
  column: "tool_calls" | "sequence";
  bytes: number;
}): string {
  return (
    `[${args.column} omitted: ${args.bytes.toLocaleString()} bytes exceeds the ` +
    `${MAX_INLINE_PAYLOAD_BYTES.toLocaleString()} byte read limit. ` +
    `The background payload backfill will move it to sidecar storage; ` +
    `reopen this chat once it finishes.]`
  );
}
