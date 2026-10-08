/**
 * Job identity in contribute-back proposals.
 *
 * A proposal describes edits to the publisher's app, so it must speak in the
 * publisher's job ids. A collaborator's copy can hold a second job with the
 * same name as one of the publisher's (an agent ran create_job instead of
 * editing the existing job, or a reinstall left two copies). Shipping it as-is
 * adds a duplicate job folder, a data/jobs.json rewrite, and re-points the
 * publisher's app code at a job only the collaborator has (PR #2 on LinkedIn
 * Outreach, 2026-10-07: SCRAPER_JOB switched to a new 3c16888c).
 *
 * Rule: a local job that is not the publisher's but has the same name as
 * exactly one publisher job is a duplicate of that job, and the proposal
 * speaks in the publisher's id:
 *  - every reference (app code, job.json, dependsOn) is rewritten to it;
 *  - the files proposed for that job are the duplicate's (the code the app
 *    actually ran); the collaborator's stale copy under the publisher's id is
 *    left out;
 *  - a duplicate nothing calls is left out.
 * Only when the app no longer calls the publisher's job: if it calls both,
 * the same-name job runs alongside and ships as a new job.
 * Jobs with a new name are genuinely new and ship unchanged.
 */

import { runGit } from "./threeWayMerge.js";

export interface LocalJobForFold {
  id: string;
  name?: string;
}

export interface PublisherJobForFold {
  id: string;
  name?: string;
}

export interface JobFoldPlan {
  /** local duplicate id → publisher job id. */
  remap: Map<string, string>;
  /** Duplicates nothing calls: left out of the proposal. */
  drop: Set<string>;
}

function normName(name: string | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

export function planJobFold(input: {
  localJobs: readonly LocalJobForFold[];
  publisherJobs: readonly PublisherJobForFold[];
  /** Text of the app's own source files (not job folders). */
  appCode: string;
}): JobFoldPlan {
  const remap = new Map<string, string>();
  const drop = new Set<string>();
  const publisherIds = new Set(input.publisherJobs.map((j) => j.id));

  const publisherByName = new Map<string, string | null>();
  for (const job of input.publisherJobs) {
    const key = normName(job.name);
    if (!key) continue;
    // Two publisher jobs with one name: ambiguous, never fold onto either.
    publisherByName.set(key, publisherByName.has(key) ? null : job.id);
  }

  const claimed = new Set<string>();
  for (const job of input.localJobs) {
    if (publisherIds.has(job.id)) continue;
    const target = publisherByName.get(normName(job.name));
    if (!target) continue; // genuinely new job
    if (!input.appCode.includes(job.id)) {
      drop.add(job.id); // nothing calls it
      continue;
    }
    // The app still calls the publisher's job too: the duplicate runs next to
    // it, so it is a genuinely new job (same name or not). Ship it as new.
    if (input.appCode.includes(target) || claimed.has(target)) continue;
    // The app switched from the publisher's job to the duplicate: it is the
    // collaborator's edited copy of that job.
    remap.set(job.id, target);
    claimed.add(target);
  }
  return { remap, drop };
}

/** Replace whole job UUIDs only. */
export function remapJobIdsInContent(content: string, remap: ReadonlyMap<string, string>): string {
  let out = content;
  for (const [from, to] of remap) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Publisher job ids + names at `sha` under `jobsRoot` ("jobs" or "Jobs"). */
export async function readPublisherJobsAtCommit(
  repoDir: string,
  sha: string,
  jobsRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<PublisherJobForFold[]> {
  let listing = "";
  try {
    listing = (await runGit(["ls-tree", "--name-only", `${sha}:${jobsRoot}`], { cwd: repoDir, env })).stdout;
  } catch {
    return [];
  }
  const jobs: PublisherJobForFold[] = [];
  for (const id of listing.split("\n").map((s) => s.trim()).filter((s) => UUID.test(s))) {
    let name: string | undefined;
    try {
      const raw = (await runGit(["cat-file", "blob", `${sha}:${jobsRoot}/${id}/job.json`], { cwd: repoDir, env })).stdout;
      name = (JSON.parse(raw) as { name?: string }).name;
    } catch {
      /* folder without a readable job.json: id only */
    }
    jobs.push({ id, name });
  }
  return jobs;
}
