/**
 * Compact Stale Tool Results
 *
 * Truncates tool results that the model has already seen and responded to,
 * while keeping the most recent batch of results at full fidelity.
 *
 * A tool result is "fresh" if the model has NOT yet produced a response after
 * seeing it. The moment the next assistant message exists, the batch becomes "stale".
 *
 * Works with both message formats:
 * - Pi-ai: { role: "toolResult", content: [{ type: "text", text }] }
 * - AI SDK: { role: "tool", content: [{ type: "tool-result", result }] }
 *
 * IMPORTANT: This should be called on a CLONED messages array right before
 * sending to the model. Never mutate persisted history.
 */

export interface CompactOpts {
  /** Number of most-recent tool batches to keep at full size. Default: 1 */
  keepLastBatches?: number;
  /** Max chars per stale tool result. Default: 2000 (~500 tokens) */
  maxStaleLength?: number;
  /** Hard cap per fresh result (prevents pathological cases). Default: 50000 (~12.5K tokens) */
  maxFreshLength?: number;
  /** Never truncate error results. Default: true */
  preserveErrors?: boolean;
}

const DEFAULTS: Required<CompactOpts> = {
  keepLastBatches: 1,
  maxStaleLength: 2000,
  maxFreshLength: 50_000,
  preserveErrors: true,
};

/**
 * Find indices of assistant messages that contain tool calls.
 * Each such message marks the start of a "tool batch" — the tool results
 * that follow it (before the next assistant message) are one logical unit.
 */
function findToolBatchBoundaries(messages: any[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    // AI SDK format: content array with tool-call blocks
    if (Array.isArray(m.content)) {
      const hasToolCall = m.content.some(
        (b: any) =>
          b.type === "tool_use" ||      // Anthropic native
          b.type === "tool-call" ||      // AI SDK
          b.type === "tool_call" ||      // OpenAI-style
          b.type === "toolCall",         // pi-ai (Mario's) — camelCase
      );
      if (hasToolCall) {
        indices.push(i);
        continue;
      }
    }
    // AI SDK also uses top-level toolInvocations
    if (Array.isArray(m.toolInvocations) && m.toolInvocations.length > 0) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Check if a tool result message represents an error.
 */
function isErrorResult(msg: any): boolean {
  // Pi-ai format
  if (msg.isError) return true;

  // Check content for error indicators
  const content = msg.content;
  if (Array.isArray(content)) {
    return content.some((part: any) => {
      if (part.type === "tool-result" && part.result) {
        const r = part.result;
        if (typeof r === "object" && r !== null) {
          return r.error || r.success === false;
        }
      }
      if (part.type === "text" && typeof part.text === "string") {
        return (
          part.text.startsWith("[Tool ") && part.text.includes("error")
        );
      }
      return false;
    });
  }

  // Direct result check (some formats)
  if (msg.result && typeof msg.result === "object") {
    return msg.result.error || msg.result.success === false;
  }

  return false;
}

/**
 * Truncate a string to maxLen, appending an elision marker.
 */
function truncateStr(s: string, maxLen: number, label?: string): string {
  if (s.length <= maxLen) return s;
  const elided = s.length - maxLen;
  const suffix = label
    ? `\n\n[… ${elided.toLocaleString()} chars truncated. tool=${label}]`
    : `\n\n[… ${elided.toLocaleString()} chars truncated]`;
  return s.substring(0, maxLen) + suffix;
}

/**
 * Apply a character limit to a single tool result message (in-place).
 * Handles both pi-ai and AI SDK message formats.
 */
function truncateToolMessage(msg: any, maxLen: number): void {
  const label = msg.toolName || msg.tool_call_id || undefined;

  // Pi-ai format: { role: "toolResult", content: [{ type: "text", text }] }
  if (msg.role === "toolResult" && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text" && typeof part.text === "string") {
        part.text = truncateStr(part.text, maxLen, label);
      }
    }
    return;
  }

  // AI SDK format: { role: "tool", content: [{ type: "tool-result", result }] }
  if (msg.role === "tool" && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "tool-result") {
        if (typeof part.result === "string") {
          part.result = truncateStr(part.result, maxLen, label);
        } else if (part.result && typeof part.result === "object") {
          // Truncate string values inside structured results
          truncateObjectStrings(part.result, maxLen, label);
        }
      }
    }
    return;
  }
}

/**
 * Recursively truncate long string values in an object.
 * Only goes 2 levels deep to avoid pathological nesting.
 */
function truncateObjectStrings(
  obj: any,
  maxLen: number,
  label?: string,
  depth = 0,
): void {
  if (depth > 2 || !obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string") {
      obj[key] = truncateStr(val, maxLen, label);
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      truncateObjectStrings(val, maxLen, label, depth + 1);
    }
  }
}

/**
 * Check if a message is a tool result (either format).
 */
function isToolResultMessage(msg: any): boolean {
  return msg.role === "toolResult" || msg.role === "tool";
}

/**
 * Compact stale tool results in a messages array.
 *
 * Call this on a CLONED array right before sending to the model.
 * Fresh results (most recent batch) stay full; stale results get truncated.
 *
 * @param messages - The messages array to compact (will be mutated)
 * @param opts - Compaction options
 */
export interface CompactStats {
  totalBatches: number;
  freshBatches: number;
  staleBatches: number;
  staleResultsTruncated: number;
  freshResultsCapped: number;
  bytesBefore: number;
  bytesAfter: number;
}

function approxBytes(messages: any[]): number {
  let n = 0;
  for (const m of messages) {
    if (!m) continue;
    if (typeof m.content === "string") { n += m.content.length; continue; }
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p?.text === "string") n += p.text.length;
        else if (typeof p?.result === "string") n += p.result.length;
        else if (p?.result) n += JSON.stringify(p.result).length;
      }
    }
  }
  return n;
}

export function estimateMessagesTokens(messages: any[]): number {
  // ~4 chars per token for English-ish content
  return Math.ceil(approxBytes(messages) / 4);
}

export function compactStaleToolResults(
  messages: any[],
  opts: CompactOpts = {},
): CompactStats {
  const o = { ...DEFAULTS, ...opts };

  // Find all assistant messages that contain tool calls.
  // Each marks the start of a batch.
  const bytesBefore = approxBytes(messages);
  const batchStarts = findToolBatchBoundaries(messages);
  const stats: CompactStats = {
    totalBatches: batchStarts.length,
    freshBatches: 0,
    staleBatches: 0,
    staleResultsTruncated: 0,
    freshResultsCapped: 0,
    bytesBefore,
    bytesAfter: bytesBefore,
  };
  if (batchStarts.length === 0) {
    console.log(`[compactToolResults] no tool batches in context — skipped`);
    return stats;
  }

  // The "stale boundary": everything before the Nth-from-last batch start is stale.
  // keepLastBatches=1 means: the last batch's results are fresh, everything else is stale.
  const freshCutoffIdx =
    batchStarts.length > o.keepLastBatches
      ? batchStarts[batchStarts.length - o.keepLastBatches]
      : -1; // All batches are fresh (fewer batches than keepLastBatches)

  if (freshCutoffIdx < 0) {
    // Not enough batches to have any stale ones. Just apply fresh cap.
    for (const msg of messages) {
      if (isToolResultMessage(msg)) {
        truncateToolMessage(msg, o.maxFreshLength);
        stats.freshResultsCapped++;
      }
    }
    stats.freshBatches = batchStarts.length;
    stats.bytesAfter = approxBytes(messages);
    console.log(
      `[compactToolResults] kept ${stats.freshBatches} fresh batches, ` +
      `no stale batches (capped ${stats.freshResultsCapped} results, ` +
      `${stats.bytesBefore} → ${stats.bytesAfter} chars)`
    );
    return stats;
  }

  // Walk through messages and apply appropriate limits
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) continue;

    // Skip error results if preserveErrors is on
    if (o.preserveErrors && isErrorResult(msg)) continue;

    if (i < freshCutoffIdx) {
      // Stale: aggressive truncation
      truncateToolMessage(msg, o.maxStaleLength);
      stats.staleResultsTruncated++;
    } else {
      // Fresh: only cap pathological results
      truncateToolMessage(msg, o.maxFreshLength);
      stats.freshResultsCapped++;
    }
  }

  stats.staleBatches = batchStarts.findIndex((idx) => idx >= freshCutoffIdx);
  if (stats.staleBatches < 0) stats.staleBatches = batchStarts.length;
  stats.freshBatches = batchStarts.length - stats.staleBatches;
  stats.bytesAfter = approxBytes(messages);

  const savedKB = Math.round((stats.bytesBefore - stats.bytesAfter) / 1024);
  console.log(
    `[compactToolResults] kept ${stats.freshBatches} fresh batches, ` +
    `compacted ${stats.staleBatches} stale ` +
    `(truncated ${stats.staleResultsTruncated} stale results, ` +
    `capped ${stats.freshResultsCapped} fresh) — ` +
    `saved ~${savedKB}KB`
  );
  return stats;
}
