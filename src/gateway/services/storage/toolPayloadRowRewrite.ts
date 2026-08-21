/**
 * Per-row surgery for the tool payload backfill.
 *
 * Each function rewrites one message's payload columns from inside SQLite, via
 * json_set/json_remove, so a 100MB column is never parsed in JS. The only
 * values that cross into JS are individual results, one at a time, on their
 * way to a sidecar file.
 *
 * `toolPayloadMigration.ts` owns scheduling and progress; this module owns the
 * SQL.
 */

import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  MAX_ROW_PAYLOAD_CHARS,
  MIN_SPILL_CHARS,
  OFFLOAD_PREVIEW_CHARS,
  OFFLOAD_THRESHOLD_CHARS,
  SIDECAR_DIRNAME,
} from "./messagePayloadStore.js";

/** Keeps a single UPDATE under SQLite's bound-parameter limit. */
const MAX_PARAMS_PER_STATEMENT = 800;

export interface MessageRow {
  id: string;
  chat_id: string;
}

/** How much a rewrite moved out of the row. */
export interface RewriteResult {
  offloaded: number;
  chars: number;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned || "_";
}

/**
 * Move every oversized result on one message into sidecar files.
 * Returns how many were moved and how many characters left the row.
 */
export function offloadRowResults(
  db: Database.Database,
  dbDir: string,
  row: MessageRow,
): RewriteResult {
  const elements = db
    .prepare(
      // CAST keeps `key` an integer: bound back as a float it would build the
      // path '$[0.0]', which json_set rejects.
      `SELECT CAST(j.key AS INTEGER) AS idx,
              json_extract(j.value, '$.id') AS tool_call_id,
              json_extract(j.value, '$.name') AS tool_name,
              LENGTH(json_extract(j.value, '$.result')) AS result_len
       FROM messages m, json_each(m.tool_calls) j
       WHERE m.id = ?
         AND json_type(j.value, '$.result') = 'text'
         AND json_extract(j.value, '$.resultOffload') IS NULL
       ORDER BY result_len DESC`,
    )
    .all(row.id) as Array<{
    idx: number;
    tool_call_id: string | null;
    tool_name: string | null;
    result_len: number;
  }>;

  if (elements.length === 0) return { offloaded: 0, chars: 0 };

  // Anything over the per-result threshold goes, plus enough of the rest
  // (largest first) to bring the row under its budget. Results are sorted
  // descending, so the first one not worth a sidecar ends the search.
  let inlineTotal = elements.reduce((sum, e) => sum + e.result_len, 0);
  const selected: typeof elements = [];
  for (const element of elements) {
    const overThreshold = element.result_len > OFFLOAD_THRESHOLD_CHARS;
    if (!overThreshold) {
      if (inlineTotal <= MAX_ROW_PAYLOAD_CHARS) break;
      if (element.result_len < MIN_SPILL_CHARS) break;
    }
    if (!element.tool_call_id) continue;
    selected.push(element);
    inlineTotal -= element.result_len;
  }

  // Paths are built in JS and bound as text; letting SQLite concatenate the
  // index risks a float creeping in.
  const readResult = db.prepare(
    `SELECT json_extract(tool_calls, ?) AS result FROM messages WHERE id = ?`,
  );
  const writeStub = db.prepare(
    `UPDATE messages
     SET tool_calls = json_set(tool_calls, ?, ?, ?, json(?))
     WHERE id = ?`,
  );

  let offloaded = 0;
  let chars = 0;

  for (const element of selected) {
    const toolCallId = element.tool_call_id as string;

    // One result in memory at a time — never the whole column.
    const { result } = readResult.get(`$[${element.idx}].result`, row.id) as {
      result: string | null;
    };
    if (typeof result !== "string") continue;

    const moved = moveToSidecar({
      dbDir,
      chatId: row.chat_id,
      messageId: row.id,
      sidecarName: toolCallId,
      toolCallId,
      toolName: element.tool_name,
      payload: result,
    });
    if (!moved) continue;

    writeStub.run(
      `$[${element.idx}].result`,
      moved.stub,
      `$[${element.idx}].resultOffload`,
      JSON.stringify(moved.ref),
      row.id,
    );

    offloaded += 1;
    chars += result.length - moved.stub.length;
  }

  return { offloaded, chars };
}

/**
 * Write one payload to its sidecar and build the stub that replaces it.
 * Returns null when the write fails, so the caller leaves the row untouched.
 */
function moveToSidecar(args: {
  dbDir: string;
  chatId: string;
  messageId: string;
  /** Filename stem; unique within the message. */
  sidecarName: string;
  /** Id quoted in the stub so `get_full_tool_result` can find it. */
  toolCallId: string;
  toolName: string | null;
  payload: string;
}): { ref: { file: string; totalChars: number }; stub: string } | null {
  const relativePath = path.join(
    SIDECAR_DIRNAME,
    sanitizeSegment(args.chatId),
    sanitizeSegment(args.messageId),
    `${sanitizeSegment(args.sidecarName)}.txt`,
  );
  const absolutePath = path.join(args.dbDir, relativePath);

  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, args.payload, "utf8");
  } catch (error) {
    console.error(
      `[PayloadMigration] Could not write sidecar for ${args.toolCallId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  const total = args.payload.length;
  const nameArg = args.toolName ? `, toolName: "${args.toolName}"` : "";
  const stub =
    args.payload.slice(0, OFFLOAD_PREVIEW_CHARS) +
    `\n\n[... ${(total - OFFLOAD_PREVIEW_CHARS).toLocaleString()} more characters ` +
    `stored outside the database (total ${total.toLocaleString()}). ` +
    `Full result: get_full_tool_result({ toolCallId: "${args.toolCallId}"${nameArg} })]`;

  return { ref: { file: relativePath, totalChars: total }, stub };
}

/**
 * Offload sequence outputs that survived slimming.
 *
 * A tool item whose `tool_calls` twin is missing keeps its own copy of the
 * output, so slimming leaves it in place. Those are the rows that would still
 * be too large to read afterwards, so move the big ones out too.
 */
export function offloadRowSequenceOutputs(
  db: Database.Database,
  dbDir: string,
  row: MessageRow,
): RewriteResult {
  const items = db
    .prepare(
      `SELECT CAST(j.key AS INTEGER) AS idx,
              json_extract(j.value, '$.data.toolCallId') AS tool_call_id,
              json_extract(j.value, '$.data.name') AS tool_name,
              LENGTH(json_extract(j.value, '$.data.output')) AS output_len
       FROM messages m, json_each(m.sequence) j
       WHERE m.id = ?
         AND json_extract(j.value, '$.type') = 'tool'
         AND json_type(j.value, '$.data.output') = 'text'
         AND json_type(j.value, '$.data.outputOffload') IS NULL
         AND LENGTH(json_extract(j.value, '$.data.output')) > ?`,
    )
    .all(row.id, OFFLOAD_THRESHOLD_CHARS) as Array<{
    idx: number;
    tool_call_id: string | null;
    tool_name: string | null;
    output_len: number;
  }>;

  if (items.length === 0) return { offloaded: 0, chars: 0 };

  const readOutput = db.prepare(
    `SELECT json_extract(sequence, ?) AS output FROM messages WHERE id = ?`,
  );
  const writeStub = db.prepare(
    `UPDATE messages
     SET sequence = json_set(sequence, ?, ?, ?, json(?))
     WHERE id = ?`,
  );

  let offloaded = 0;
  let chars = 0;

  for (const item of items) {
    const { output } = readOutput.get(
      `$[${item.idx}].data.output`,
      row.id,
    ) as { output: string | null };
    if (typeof output !== "string") continue;

    const toolCallId = item.tool_call_id ?? `sequence-${item.idx}`;
    const moved = moveToSidecar({
      dbDir,
      chatId: row.chat_id,
      messageId: row.id,
      sidecarName: `orphan-${toolCallId}`,
      toolCallId,
      toolName: item.tool_name,
      payload: output,
    });
    if (!moved) continue;

    writeStub.run(
      `$[${item.idx}].data.output`,
      moved.stub,
      `$[${item.idx}].data.outputOffload`,
      JSON.stringify(moved.ref),
      row.id,
    );

    offloaded += 1;
    chars += output.length - moved.stub.length;
  }

  return { offloaded, chars };
}

/**
 * Drop the payloads `sequence` duplicates from `tool_calls`, leaving pointers.
 * This is where most of the reclaimed space comes from.
 */
export function slimRowSequence(db: Database.Database, row: MessageRow): void {
  const toolItems = db
    .prepare(
      `SELECT CAST(j.key AS INTEGER) AS idx,
              json_extract(j.value, '$.data.toolCallId') AS tool_call_id,
              json_type(j.value, '$.data.input') AS input_type,
              json_type(j.value, '$.data.output') AS output_type
       FROM messages m, json_each(m.sequence) j
       WHERE m.id = ?
         AND json_extract(j.value, '$.type') = 'tool'
         AND json_type(j.value, '$.data.outputRef') IS NULL
         AND json_type(j.value, '$.data.inputRef') IS NULL`,
    )
    .all(row.id) as Array<{
    idx: number;
    tool_call_id: string | null;
    input_type: string | null;
    output_type: string | null;
  }>;

  if (toolItems.length === 0) return;

  // Only point at payloads that `tool_calls` can actually give back.
  const twins = db
    .prepare(
      `SELECT json_extract(j.value, '$.id') AS id,
              json_type(j.value, '$.args') AS args_type,
              json_type(j.value, '$.result') AS result_type
       FROM messages m, json_each(m.tool_calls) j
       WHERE m.id = ?`,
    )
    .all(row.id) as Array<{
    id: string | null;
    args_type: string | null;
    result_type: string | null;
  }>;

  const twinById = new Map(twins.map((t) => [t.id, t]));

  const removePaths: string[] = [];
  const setArgs: string[] = [];

  for (const item of toolItems) {
    const twin = item.tool_call_id ? twinById.get(item.tool_call_id) : undefined;
    if (!twin) continue;

    if (item.input_type !== null && twin.args_type !== null) {
      removePaths.push(`$[${item.idx}].data.input`);
      setArgs.push(`$[${item.idx}].data.inputRef`, "toolCall");
    }

    // A JSON `null` output serializes to nothing in `tool_calls`, so it has to
    // stay inline to survive the round trip.
    if (
      item.output_type !== null &&
      item.output_type !== "null" &&
      twin.result_type === "text"
    ) {
      removePaths.push(`$[${item.idx}].data.output`);
      setArgs.push(
        `$[${item.idx}].data.outputRef`,
        item.output_type === "text" ? "toolCall:string" : "toolCall:json",
      );
    }
  }

  if (removePaths.length === 0) return;

  // json_remove/json_set are variadic; batch so no statement exceeds the
  // bound-parameter limit on turns with very many tool calls.
  const perBatch = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / 6));
  for (let i = 0; i < removePaths.length; i += perBatch) {
    const removeBatch = removePaths.slice(i, i + perBatch);
    const setBatch = setArgs.slice(i * 2, (i + perBatch) * 2);

    const removeSql = removeBatch.map(() => "?").join(", ");
    const setSql = setBatch.map(() => "?").join(", ");

    db.prepare(
      `UPDATE messages
       SET sequence = json_set(json_remove(sequence, ${removeSql}), ${setSql})
       WHERE id = ?`,
    ).run(...removeBatch, ...setBatch, row.id);
  }
}
