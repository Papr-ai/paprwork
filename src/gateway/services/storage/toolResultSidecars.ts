/**
 * Sidecar storage for oversized tool results.
 *
 * A result too large to keep in a SQLite row moves to a file under
 * `<dbDir>/tool-results/<chatId>/<messageId>/<toolCallId>.txt`, and the row
 * keeps a preview plus a pointer to it. Nothing is discarded — the full text
 * stays on disk and `get_full_tool_result` follows the pointer.
 *
 * This module owns the file layout, the size budgets and the inline stub
 * format. `messagePayloadStore.ts` decides which results to offload on write,
 * and `toolPayloadRowRewrite.ts` does the same for existing rows.
 */

import fs from "fs";
import path from "path";

/** Results longer than this move to a sidecar file instead of living in the row. */
export const OFFLOAD_THRESHOLD_CHARS = 256 * 1024;

/**
 * How much of an offloaded result stays inline.
 *
 * Sized to the default `absoluteMaxChars` (40,000) so offloading never takes
 * away context the model would otherwise have received: the history formatter
 * caps every category at or below that ceiling, so it truncates from the
 * preview exactly as it would have from the full result. The tail beyond this
 * is only reachable via `get_full_tool_result`, which is a full-retention tool.
 *
 * Raising `absoluteMaxChars` above this in Settings -> Agent Context (or turning
 * truncation off) means results over the offload threshold reach the model as
 * this preview plus a pointer rather than in full.
 */
export const OFFLOAD_PREVIEW_CHARS = 40_000;

/**
 * Fallback preview used when the row budget cannot be met otherwise. Keeping
 * 40K per result would blow the budget on a turn with dozens of huge results,
 * so those degrade to a short preview instead of an unbounded row.
 */
export const COMPACT_PREVIEW_CHARS = 4096;

/**
 * Budget for the whole `tool_calls` column. A turn with dozens of results that
 * each sit just under the per-result threshold would otherwise still add up to
 * a huge row, so the largest ones spill to sidecars until the row fits.
 */
export const MAX_ROW_PAYLOAD_CHARS = 1024 * 1024;

/** Not worth a sidecar file below this size. */
export const MIN_SPILL_CHARS = 8 * 1024;

export const SIDECAR_DIRNAME = "tool-results";

/** Pointer left in `tool_calls` when a result was moved to a sidecar file. */
export interface OffloadedResultRef {
  /** Sidecar location, relative to the directory holding chats.db. */
  file: string;
  /** Length in characters of the full result. */
  totalChars: number;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned || "_";
}

/**
 * Inline stand-in for an offloaded result: the head of the payload plus a
 * notice telling the reader how to reach the rest. Shared with the backfill so
 * a row written today and a row migrated later look identical.
 */
export function buildOffloadStub(args: {
  payload: string;
  previewChars: number;
  toolCallId: string;
  toolName?: string;
  /**
   * Length of the original result. Required when `payload` is itself already a
   * preview, since its length no longer describes the full payload.
   */
  totalChars?: number;
}): string {
  const total = args.totalChars ?? args.payload.length;
  const remaining = Math.max(total - args.previewChars, 0);
  const nameArg = args.toolName ? `, toolName: "${args.toolName}"` : "";
  return (
    args.payload.slice(0, args.previewChars) +
    `\n\n[... ${remaining.toLocaleString()} more characters stored outside the database ` +
    `(total ${total.toLocaleString()}). ` +
    `Full result: get_full_tool_result({ toolCallId: "${args.toolCallId}"${nameArg} })]`
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
export function offloadResult(args: {
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
      `[ToolResultSidecars] Failed to offload result for ${args.toolCallId}, keeping it inline:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
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
    console.error(`[ToolResultSidecars] Rejected out-of-tree ref: ${ref.file}`);
    return null;
  }

  try {
    return fs.readFileSync(target, "utf8");
  } catch (error) {
    console.error(
      `[ToolResultSidecars] Missing sidecar ${ref.file}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Drop every sidecar belonging to a chat (called when the chat is deleted). */
export function deleteChatSidecars(dbDir: string, chatId: string): void {
  const dir = path.join(dbDir, SIDECAR_DIRNAME, sanitizeSegment(chatId));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[ToolResultSidecars] Could not remove sidecars for chat ${chatId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
