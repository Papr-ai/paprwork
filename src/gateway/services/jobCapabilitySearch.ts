/**
 * Read path for job capability cards.
 *
 * This is the half that makes the writer worth having. Before this existed,
 * `create_job` performed NO discovery of any kind — it validated arguments and
 * wrote the job. With 514 jobs on disk, an agent cannot recall whether a
 * calendar reader already exists, and cannot look it up by name because it
 * does not know the name. The result is job #515 duplicating job #40407339.
 *
 * WARN, DO NOT BLOCK
 * ------------------
 * A high-confidence match surfaces the existing job; it never prevents
 * creation. Semantic similarity is a heuristic, and a false block ("you
 * already have this" when the user wants something subtly different) is worse
 * than a duplicate job: it is unarguable from the user's side and it breaks a
 * workflow that used to work. A duplicate job is annoying and reversible.
 */

import Papr from "@papr/memory";
import { getApiKey } from "../utils/keyResolver.js";
import { paprMemorySearchScopeSpread } from "../utils/memoryScopeResolver.js";

export interface SimilarJobCapability {
  jobId: string;
  jobName: string;
  summary: string;
  score?: number;
}

/**
 * Find existing jobs whose capability resembles `intent`.
 *
 * Returns [] on any failure — discovery is advisory, and a memory outage must
 * never stop a job from being created.
 */
export async function findSimilarJobCapabilities(
  intent: string,
  limit = 3,
): Promise<SimilarJobCapability[]> {
  if (!intent?.trim()) return [];

  try {
    const apiKey = await getApiKey("PAPR_API_KEY");
    if (!apiKey) return [];

    const client = new Papr({ xAPIKey: apiKey, maxRetries: 1, timeout: 10000 });
    const scope = await paprMemorySearchScopeSpread();

    const response = await client.memory.search({
      query: intent,
      ...scope,
      max_memories: limit,
      max_nodes: 0,
      enable_agentic_graph: false,
      metadata: {
        customMetadata: { content_type: "job_capability" },
      },
    });

    const memories =
      (response as { data?: { memories?: Array<Record<string, unknown>> } })
        ?.data?.memories ?? [];

    const results: SimilarJobCapability[] = [];
    for (const m of memories) {
      const cm =
        ((m.customMetadata ?? m.metadata) as Record<string, unknown>) ?? {};
      const jobId = String(cm.jobId ?? "");
      if (!jobId) continue;
      const content = String(m.content ?? "");
      results.push({
        jobId,
        jobName: String(cm.jobName ?? "unknown"),
        // First lines are the header and purpose — enough to decide.
        summary: content.split("\n").slice(0, 3).join("\n"),
        score:
          typeof m.relevance_score === "number" ? m.relevance_score : undefined,
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Build the advisory line shown when a similar job already exists.
 *
 * Deliberately phrased as information, not an error: the caller proceeds.
 */
export function formatSimilarJobsWarning(
  matches: SimilarJobCapability[],
): string | undefined {
  if (matches.length === 0) return undefined;

  const lines = matches.map(
    (m) => `  • ${m.jobName} (${m.jobId})\n    ${m.summary.replace(/\n/g, "\n    ")}`,
  );
  return (
    `NOTE: ${matches.length} existing job(s) may already do this — ` +
    `check before building a duplicate:\n${lines.join("\n")}\n` +
    `The new job was still created. Use list_jobs or delete_job if one of the above is what you wanted.`
  );
}
