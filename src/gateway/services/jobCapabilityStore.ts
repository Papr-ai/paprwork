/**
 * Persist job capability cards to Papr Memory, one per job, updated in place.
 *
 * WRITE PROTOCOL
 * --------------
 *   1. build the card (deterministic: no run id, no date)
 *   2. resolve source_key -> memoryId via a local index
 *   3. unchanged content -> no-op        (the common case)
 *      no memoryId       -> add()
 *      changed content   -> update() in place, keeping the same memoryId
 *
 * Step 3's "unchanged" branch is what bounds the cost. A job running every 15
 * minutes writes ONCE, then never again until its schema or purpose changes.
 *
 * The local index is a JSON file rather than a table in the job's own data.db:
 * the mapping is cross-job (one entry per job id) and must survive a job's
 * database being rebuilt or reseeded.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import Papr from "@papr/memory";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import { getApiKey } from "../utils/keyResolver.js";
import { paprMemoryScopeSpread } from "../utils/memoryScopeResolver.js";
import type { JobRecord } from "./jobs/types.js";
import {
  buildJobCapabilityCard,
  jobCapabilitySourceKey,
  readJobReliability,
  readJobTableShapes,
  type JobTableShape,
} from "./jobCapabilityCard.js";

const INDEX_FILENAME = ".job-capability-cards.json";

interface CardIndexEntry {
  memoryId: string;
  contentHash: string;
  updatedAt: string;
}

type CardIndex = Record<string, CardIndexEntry>;

export interface JobCapabilityWriteResult {
  written: boolean;
  reason:
    | "unchanged"
    | "created"
    | "updated"
    | "no_api_key"
    | "no_tables"
    | "error";
  memoryId?: string;
}

function indexPath(): string {
  return path.join(getPaprDataDir(), INDEX_FILENAME);
}

function loadIndex(): CardIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as CardIndex;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* first run or unreadable — treat as empty */
  }
  return {};
}

function saveIndex(index: CardIndex): void {
  try {
    const target = indexPath();
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), "utf8");
    fs.renameSync(tmp, target);
  } catch {
    /* index is an optimisation — a failure here must not fail the write */
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Write (or skip) the capability card for one job.
 *
 * Never throws: capability cards are an enhancement to discovery, and a job
 * run must not be marked failed because its card could not be stored.
 */
export async function syncJobCapabilityCard(input: {
  job: JobRecord;
  jobDir: string;
  successRate?: number;
  runSampleSize?: number;
}): Promise<JobCapabilityWriteResult> {
  try {
    const dbPath = path.join(input.jobDir, "data", "data.db");
    let tables: JobTableShape[] = [];
    // Reliability comes from job_runs in the same data.db, so an explicit
    // caller value wins but we fall back to reading history ourselves.
    let successRate = input.successRate;
    let runSampleSize = input.runSampleSize;
    if (fs.existsSync(dbPath)) {
      tables = readJobTableShapes(dbPath);
      if (successRate === undefined) {
        const reliability = readJobReliability(dbPath);
        if (reliability) {
          successRate = reliability.successRate;
          runSampleSize = reliability.runSampleSize;
        }
      }
    }

    const content = buildJobCapabilityCard({
      job: input.job,
      tables,
      successRate,
      runSampleSize,
    });

    const sourceKey = jobCapabilitySourceKey(input.job.id);
    const contentHash = hashContent(content);

    const index = loadIndex();
    const existing = index[sourceKey];

    // The common path: nothing about this job's capability changed.
    if (existing && existing.contentHash === contentHash) {
      return { written: false, reason: "unchanged", memoryId: existing.memoryId };
    }

    const apiKey = await getApiKey("PAPR_API_KEY");
    if (!apiKey) {
      return { written: false, reason: "no_api_key" };
    }

    const client = new Papr({ xAPIKey: apiKey, maxRetries: 2, timeout: 30000 });
    const scope = await paprMemoryScopeSpread();

    const metadata = {
      role: "assistant" as const,
      category: "fact" as const,
      customMetadata: {
        source: "job_capability",
        content_type: "job_capability",
        source_key: sourceKey,
        artifact: "job_capability",
        jobId: input.job.id,
        jobName: input.job.name,
        jobType: input.job.type,
        appIds: (input.job.appIds ?? []).join(","),
        tables: tables.map((t) => t.table).join(","),
        content_hash: contentHash,
      },
    };

    // UPDATE IN PLACE when we already own a memory id — same reasoning as
    // CodeSummaryMemoryStore.upsertSummary: delete-then-add duplicates on the
    // unhappy path, and the server derives memoryId from content so both
    // documents would share an id and collapse search result slots.
    if (existing?.memoryId) {
      try {
        await client.memory.update(existing.memoryId, { content, metadata });
        index[sourceKey] = {
          memoryId: existing.memoryId,
          contentHash,
          updatedAt: new Date().toISOString(),
        };
        saveIndex(index);
        return { written: true, reason: "updated", memoryId: existing.memoryId };
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status !== 404) {
          console.warn(
            `[jobCapability] update failed for job ${input.job.id}:`,
            error,
          );
          return { written: false, reason: "error" };
        }
        // 404 is the one case where falling through to add() is correct: the
        // memory we tracked is genuinely gone.
      }
    }

    const response = await client.memory.add({ content, ...scope, metadata });
    const memoryId =
      (response as { data?: Array<{ memoryId?: string }> })?.data?.[0]
        ?.memoryId ?? undefined;

    if (memoryId) {
      index[sourceKey] = {
        memoryId,
        contentHash,
        updatedAt: new Date().toISOString(),
      };
      saveIndex(index);
    }
    return { written: true, reason: "created", memoryId };
  } catch (error) {
    console.warn(
      `[jobCapability] failed to sync card for job ${input.job?.id}:`,
      error,
    );
    return { written: false, reason: "error" };
  }
}
