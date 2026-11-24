/**
 * Training-grade cloud copy — only for users who opted in.
 *
 * Today's sync (paprSyncPayload.ts) keeps a chat readable in the cloud: tool
 * arguments cut to 500 chars, results to 500 chars, anything over 80 KB reduced
 * to a summary. That is fine for backup, and useless for learning *what the agent
 * did*: the args of a search, the result it read, and the edit that followed.
 *
 * For opted-in users this module adds, per tool call, a `training` block:
 *   - args in full (bounded at ARGS_MAX; larger args go to the bucket like results)
 *   - the result inline when small, otherwise a pointer `{ sha256, bytes, key }`
 *     to the private training bucket (memory: POST /v1/training/tool-results/upload)
 *   - searchId / useCase when the tool was a search (joins QueryLog rows)
 * and marks the row `trainingEligible` so the server can double-check consent.
 *
 * Opted-out users: nothing here runs. The existing payload is sent unchanged.
 *
 * Consent lives on the Papr account (GET/PUT /v1/training/consent), so cloud
 * agents, jobs and every signed-in desktop agree. The local cache below is only
 * a read-through: one lookup per 5 minutes, fails closed.
 */

import crypto from "crypto";
import type { StoredMessage } from "./IStorageProvider.js";
import {
  measurePaprStoreBodyBytes,
  PAPR_SYNC_MAX_BYTES,
  type PaprContentBlock,
  type PaprMessageStoreBody,
} from "./paprSyncPayload.js";

/** Inline a result up to this many bytes; above it, upload and keep a pointer. */
export const TRAINING_INLINE_RESULT_BYTES = 16_000;
// (shrinkUntilFits lowers this per turn when the row would exceed PAPR_SYNC_MAX_BYTES.)
/** Args larger than this are uploaded too (rare: write_file of a big file). */
export const TRAINING_ARGS_MAX_BYTES = 16_000;
/** The server rejects single results above this; we keep a preview only. */
export const TRAINING_RESULT_MAX_BYTES = 50 * 1024 * 1024;
/** Opt-in wording version. Bump when the Privacy text changes so users are re-asked. */
export const TRAINING_CONSENT_VERSION = "2026-11-20";

export interface TrainingResultRef {
  sha256: string;
  bytes: number;
  /** Bucket key once uploaded; absent if upload failed (row still syncs, marked). */
  key?: string;
  uploadFailed?: boolean;
}

export interface TrainingToolBlock {
  tool_use_id: string;
  name: string;
  status?: string;
  args?: Record<string, unknown>;
  argsRef?: TrainingResultRef;
  result?: string;
  resultRef?: TrainingResultRef;
  /** Set by search tools via recordSearchOnToolCall. */
  searchId?: string;
  useCase?: string;
}

// ---------------------------------------------------------------- consent cache

const CONSENT_TTL_MS = 5 * 60_000;
let consentCache: { at: number; value: boolean } | null = null;

type ConsentFetcher = () => Promise<boolean>;
let fetchConsent: ConsentFetcher = defaultFetchConsent;

async function defaultFetchConsent(): Promise<boolean> {
  const { getPaprClient } = await import("../../../core/tools/paprClient.js");
  const client = await getPaprClient();
  return consentAllowsTraining(await client.get("/v1/training/consent", { timeout: 8_000 }));
}

/**
 * Feature-flagged OFF: the server only reports `available: true` for accounts on
 * its internal allowlist (TRAINING_PROGRAM_ALLOWLIST). Missing/false — including
 * any older server that predates the flag — means no training sync, ever.
 */
export function consentAllowsTraining(res: unknown): boolean {
  const r = res as { opted_in?: unknown; available?: unknown } | null | undefined;
  return r?.available === true && r?.opted_in === true;
}

/** Cached account consent. Any error → false (never upload on doubt). */
export async function isTrainingOptedIn(now = Date.now()): Promise<boolean> {
  if (process.env.PAPR_TRAINING_SYNC === "0") return false;
  if (consentCache && now - consentCache.at < CONSENT_TTL_MS) return consentCache.value;
  let value = false;
  try {
    value = await fetchConsent();
  } catch {
    value = false;
  }
  consentCache = { at: now, value };
  return value;
}

/** Called after the user flips the switch so the next sync uses the new value. */
export function setTrainingOptInCache(value: boolean, now = Date.now()): void {
  consentCache = { at: now, value };
}

export function setTrainingConsentFetcherForTests(f: ConsentFetcher | null): void {
  fetchConsent = f ?? defaultFetchConsent;
  consentCache = null;
}

// ---------------------------------------------------------------- uploads

type Uploader = (text: string, sha256: string, bytes: number) => Promise<string>;
let uploader: Uploader = defaultUpload;

async function defaultUpload(text: string, sha256: string, bytes: number): Promise<string> {
  const { getPaprClient } = await import("../../../core/tools/paprClient.js");
  const client = await getPaprClient();
  const ticket = (await client.post("/v1/training/tool-results/upload", {
    body: { sha256, size_bytes: bytes },
    timeout: 15_000,
  })) as { object_key: string; upload_url?: string | null; already_exists: boolean };
  if (!ticket.already_exists && ticket.upload_url) {
    const r = await fetch(ticket.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    });
    if (!r.ok) throw new Error(`upload failed (${r.status})`);
  }
  return ticket.object_key;
}

export function setTrainingUploaderForTests(u: Uploader | null): void {
  uploader = u ?? defaultUpload;
}

async function refFor(text: string): Promise<TrainingResultRef> {
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  if (bytes > TRAINING_RESULT_MAX_BYTES) return { sha256, bytes, uploadFailed: true };
  try {
    return { sha256, bytes, key: await uploader(text, sha256, bytes) };
  } catch {
    return { sha256, bytes, uploadFailed: true };
  }
}

// ---------------------------------------------------------------- full tool blocks

type ToolCall = NonNullable<StoredMessage["toolCalls"]>[number] & {
  searchId?: string;
  useCase?: string;
};

/**
 * Full-result text for one call. Results the local store offloaded to a sidecar
 * file carry only a preview inline; `readFull` returns the original.
 */
export type FullResultReader = (
  tc: ToolCall,
  message: StoredMessage,
) => Promise<string | undefined | null>;

export async function buildTrainingToolBlocks(
  message: StoredMessage,
  readFull: FullResultReader,
): Promise<TrainingToolBlock[]> {
  const out: TrainingToolBlock[] = [];
  for (const raw of (message.toolCalls ?? []) as ToolCall[]) {
    const block: TrainingToolBlock = { tool_use_id: raw.id, name: raw.name };
    if (raw.status) block.status = raw.status;
    if (raw.searchId) block.searchId = raw.searchId;
    if (raw.useCase) block.useCase = raw.useCase;

    const argsText = JSON.stringify(raw.args ?? {});
    if (Buffer.byteLength(argsText, "utf8") <= TRAINING_ARGS_MAX_BYTES) block.args = raw.args ?? {};
    else block.argsRef = await refFor(argsText);

    const full = raw.resultOffload ? (await readFull(raw, message)) ?? raw.result : raw.result;
    if (typeof full === "string" && full.length > 0) {
      if (Buffer.byteLength(full, "utf8") <= TRAINING_INLINE_RESULT_BYTES) block.result = full;
      else block.resultRef = await refFor(full);
    }
    out.push(block);
  }
  return out;
}

/**
 * Move the largest inline result/args to the bucket, one at a time, until
 * `fits()` holds. Nothing is ever truncated: a field is either inline in full or
 * a pointer to the full text. Returns false if even all-pointers does not fit.
 */
export async function shrinkUntilFits(blocks: TrainingToolBlock[], fits: () => boolean): Promise<boolean> {
  while (!fits()) {
    let best: { b: TrainingToolBlock; field: "result" | "args"; bytes: number } | null = null;
    for (const b of blocks) {
      if (b.result) {
        const n = Buffer.byteLength(b.result, "utf8");
        if (!best || n > best.bytes) best = { b, field: "result", bytes: n };
      }
      if (b.args) {
        const n = Buffer.byteLength(JSON.stringify(b.args), "utf8");
        if (n > 200 && (!best || n > best.bytes)) best = { b, field: "args", bytes: n };
      }
    }
    if (!best) return false;
    if (best.field === "result") {
      best.b.resultRef = await refFor(best.b.result!);
      delete best.b.result;
    } else {
      best.b.argsRef = await refFor(JSON.stringify(best.b.args));
      delete best.b.args;
    }
  }
  return true;
}

/**
 * The training payload as one content block. Sent as the LAST block of the
 * message so readers that only know text/tool_use/tool_result skip it.
 * Byte budget: args and results above 16 KB are pointers, so even a 60-call turn
 * stays well under the 80 KB row cap; if it does not, callers drop the block
 * (the row still syncs, without training data) rather than truncating it.
 */
export function trainingContentBlock(blocks: TrainingToolBlock[]): PaprContentBlock {
  return { type: "training_tool_calls", calls: blocks } as unknown as PaprContentBlock;
}

// ---------------------------------------------------------------- search → tool call

/**
 * Search tools call this with the id their search returned. The agent loop
 * copies it onto the stored tool call (toolCallId match), so the local row and
 * the synced row both say which QueryLog this tool call produced.
 */
const pendingSearchTags = new Map<string, { searchId: string; useCase: string }>();

export function recordSearchOnToolCall(toolCallId: string | undefined, searchId: string | null | undefined, useCase: string): void {
  if (!toolCallId || !searchId) return;
  pendingSearchTags.set(toolCallId, { searchId, useCase });
  // Bounded: a crashed turn must not leak entries forever.
  if (pendingSearchTags.size > 2_000) {
    const first = pendingSearchTags.keys().next().value;
    if (first) pendingSearchTags.delete(first);
  }
}

/** Attach recorded search ids to the turn's tool calls (mutates; returns count). */
export function applySearchTags(toolCalls: StoredMessage["toolCalls"]): number {
  let n = 0;
  for (const tc of (toolCalls ?? []) as ToolCall[]) {
    const tag = pendingSearchTags.get(tc.id);
    if (!tag) continue;
    tc.searchId = tag.searchId;
    tc.useCase = tag.useCase;
    pendingSearchTags.delete(tc.id);
    n++;
  }
  return n;
}

export function resetSearchTagsForTests(): void {
  pendingSearchTags.clear();
}

// ---------------------------------------------------------------- store body

/**
 * Add the training block + join keys to a store body, in place, when the user
 * is opted in. Never throws: a failure leaves the body as today's sync built it.
 */
export async function attachTrainingPayload(
  body: PaprMessageStoreBody,
  message: StoredMessage,
  readFull: FullResultReader,
): Promise<boolean> {
  try {
    // The client id is the join key for QueryLog.clientMessageId. Harmless for
    // everyone (it is our own id), so it is sent regardless of consent.
    body.metadata.customMetadata.clientMessageId = message.id;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      if (await isTrainingOptedIn()) body.metadata.customMetadata.trainingEligible = true;
      return false;
    }
    if (!(await isTrainingOptedIn())) return false;
    const blocks = await buildTrainingToolBlocks(message, readFull);
    // The truncated tool_result previews duplicate what the training block holds
    // in full (or by pointer), so drop them to make room; tool_use stays for the
    // cloud history view.
    const base: PaprContentBlock[] = (Array.isArray(body.content)
      ? body.content
      : [{ type: "text", text: body.content } as PaprContentBlock]
    ).filter((c) => c.type !== "tool_result");
    const metadata = {
      ...body.metadata,
      customMetadata: { ...body.metadata.customMetadata, trainingEligible: true },
    };
    const candidate = (): PaprMessageStoreBody => ({
      ...body,
      content: [...base, trainingContentBlock(blocks)],
      metadata,
    });
    const fits = () => measurePaprStoreBodyBytes(candidate()) <= PAPR_SYNC_MAX_BYTES;
    if (!(await shrinkUntilFits(blocks, fits))) {
      body.metadata.customMetadata.trainingPayloadDropped = true;
      return false;
    }
    const final = candidate();
    body.content = final.content;
    body.metadata = final.metadata;
    return true;
  } catch {
    return false;
  }
}
