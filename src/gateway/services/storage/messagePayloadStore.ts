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
 */

import fs from "fs";
import path from "path";
import type { StoredMessage } from "./IStorageProvider.js";

/** Results longer than this move to a sidecar file instead of living in the row. */
export const OFFLOAD_THRESHOLD_CHARS = 256 * 1024;

/** How much of an offloaded result stays inline so the UI still shows something. */
export const OFFLOAD_PREVIEW_CHARS = 4096;

/**
 * Budget for the whole `tool_calls` column. A turn with dozens of results that
 * each sit just under the per-result threshold would otherwise still add up to
 * a huge row, so the largest ones spill to sidecars until the row fits.
 */
export const MAX_ROW_PAYLOAD_CHARS = 1024 * 1024;

/** Not worth a sidecar file below this size. */
export const MIN_SPILL_CHARS = 8 * 1024;

/**
 * Largest single column we are willing to pull into JS and parse. Rows written
 * before offloading existed can be hundreds of megabytes, and parsing one was
 * enough to exhaust the heap, so the read path skips them instead.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 2 * 1024 * 1024;

export const SIDECAR_DIRNAME = "tool-results";

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

/** Pointer left in `tool_calls` when a result was moved to a sidecar file. */
export interface OffloadedResultRef {
  /** Sidecar location, relative to the directory holding chats.db. */
  file: string;
  /** Length in characters of the full result. */
  totalChars: number;
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

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned || "_";
}

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

function buildOffloadNotice(
  ref: OffloadedResultRef,
  toolCallId: string,
  toolName?: string,
): string {
  const remaining = ref.totalChars - OFFLOAD_PREVIEW_CHARS;
  const nameArg = toolName ? `, toolName: "${toolName}"` : "";
  return (
    `\n\n[... ${remaining.toLocaleString()} more characters stored outside the database ` +
    `(total ${ref.totalChars.toLocaleString()}). ` +
    `Full result: get_full_tool_result({ toolCallId: "${toolCallId}"${nameArg} })]`
  );
}

function writeSidecar(absolutePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tmpPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, "utf8");
  fs.renameSync(tmpPath, absolutePath);
}

/**
 * Move a single oversized result to a sidecar file.
 * Returns null when the write fails, so the caller keeps the result inline
 * rather than losing it.
 */
function offloadResult(args: {
  dbDir: string;
  chatId: string;
  messageId: string;
  toolCallId: string;
  result: string;
}): OffloadedResultRef | null {
  const relativePath = path.join(
    SIDECAR_DIRNAME,
    sanitizeSegment(args.chatId),
    sanitizeSegment(args.messageId),
    `${sanitizeSegment(args.toolCallId)}.txt`,
  );

  try {
    writeSidecar(path.join(args.dbDir, relativePath), args.result);
    return { file: relativePath, totalChars: args.result.length };
  } catch (error) {
    console.error(
      `[MessagePayloadStore] Failed to offload result for ${args.toolCallId}, keeping it inline:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
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

    tc.result =
      tc.result.slice(0, OFFLOAD_PREVIEW_CHARS) +
      buildOffloadNotice(
        ref,
        toolCallId,
        typeof tc.name === "string" ? tc.name : undefined,
      );
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
 * Move the largest remaining inline results to sidecars until the row fits the
 * budget. Mutates the records in place.
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
    if (!largest || typeof largest.id !== "string") return;

    const ref = offloadResult({
      dbDir: args.dbDir,
      chatId: args.chatId,
      messageId: args.messageId,
      toolCallId: largest.id,
      result: largest.result as string,
    });
    if (!ref) return;

    largest.result =
      (largest.result as string).slice(0, OFFLOAD_PREVIEW_CHARS) +
      buildOffloadNotice(
        ref,
        largest.id,
        typeof largest.name === "string" ? largest.name : undefined,
      );
    largest.resultOffload = ref;
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
    output:
      serialized.slice(0, OFFLOAD_PREVIEW_CHARS) +
      buildOffloadNotice(
        ref,
        toolCallId,
        typeof data.name === "string" ? data.name : undefined,
      ),
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

/** Read a result that was moved to a sidecar file. */
export function readOffloadedResult(
  dbDir: string,
  ref: OffloadedResultRef,
): string | null {
  const root = path.resolve(dbDir, SIDECAR_DIRNAME);
  const target = path.resolve(dbDir, ref.file);

  // Refs come from our own rows, but a corrupted value should not read
  // arbitrary files.
  if (target !== root && !target.startsWith(root + path.sep)) {
    console.error(`[MessagePayloadStore] Rejected out-of-tree ref: ${ref.file}`);
    return null;
  }

  try {
    return fs.readFileSync(target, "utf8");
  } catch (error) {
    console.error(
      `[MessagePayloadStore] Missing sidecar ${ref.file}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
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

/** Drop every sidecar belonging to a chat (called when the chat is deleted). */
export function deleteChatSidecars(dbDir: string, chatId: string): void {
  const dir = path.join(dbDir, SIDECAR_DIRNAME, sanitizeSegment(chatId));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[MessagePayloadStore] Could not remove sidecars for chat ${chatId}:`,
      error instanceof Error ? error.message : error,
    );
  }
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
