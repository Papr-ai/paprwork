/**
 * Keep a job's cloud placement honest about what its code needs.
 *
 * When a job's code needs the desktop (see utils/jobDesktopOnly.ts) and nobody has
 * chosen a placement, pin it to local-only and record why. If the code later
 * stops needing the desktop, undo only what we pinned. A placement someone chose
 * (UI or update_job) is never overridden — we only attach the reason.
 */
import { promises as fs } from "fs";
import path from "path";
import {
  detectJobDesktopOnly,
  DESKTOP_ONLY_REASON,
  referencedJobIds,
  summarizeDesktopOnly,
  type DesktopOnlyHit,
} from "../../utils/jobDesktopOnly.js";
import { defaultExecutionCapabilityForAppIds } from "./executionCapability.js";
import type { JobRecord } from "./types.js";

const CODE_FILE = /\.(py|js|mjs|cjs|ts|sh|bash|swift)$/i;
const SKIP_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__", "logs", "data", "runs", ".versions", ".git", "migrations",
]);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;

/** Job's own code files (relative path → content), bounded. */
export async function collectJobCodeFiles(jobDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.size >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= MAX_FILES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, childRel);
        continue;
      }
      if (!entry.isFile() || !CODE_FILE.test(entry.name)) continue;
      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        out.set(childRel, await fs.readFile(full, "utf8"));
      } catch {
        /* unreadable — skip */
      }
    }
  }
  await walk(jobDir, "");
  return out;
}

export interface DesktopOnlyDecision {
  /** Fields to write onto the job, or null when nothing changes. */
  patch: Pick<JobRecord, "executionCapability" | "localOnlyReason" | "localOnlyAuto"> | null;
  hits: DesktopOnlyHit[];
  /** True when the code needs the desktop but someone chose a cloud placement. */
  conflictsWithChoice: boolean;
}

export function decideDesktopOnly(
  job: Pick<JobRecord, "appIds" | "executionCapability" | "localOnlyReason" | "localOnlyAuto">,
  hits: DesktopOnlyHit[],
): DesktopOnlyDecision {
  const reason = summarizeDesktopOnly(hits);
  const chosen = job.executionCapability !== undefined && !job.localOnlyAuto;

  if (reason) {
    if (!chosen) {
      if (job.executionCapability === "local-only" && job.localOnlyReason === reason && job.localOnlyAuto) {
        return { patch: null, hits, conflictsWithChoice: false };
      }
      return {
        patch: { executionCapability: "local-only", localOnlyReason: reason, localOnlyAuto: true },
        hits,
        conflictsWithChoice: false,
      };
    }
    if (job.executionCapability === "local-only") {
      // Someone chose local-only — keep it, just record why for the cloud card.
      return job.localOnlyReason === reason
        ? { patch: null, hits, conflictsWithChoice: false }
        : {
            patch: { executionCapability: "local-only", localOnlyReason: reason, localOnlyAuto: false },
            hits,
            conflictsWithChoice: false,
          };
    }
    return { patch: null, hits, conflictsWithChoice: true };
  }

  if (job.localOnlyAuto) {
    // We pinned it and the code no longer needs the desktop — undo our pin only.
    return {
      patch: {
        executionCapability: defaultExecutionCapabilityForAppIds(job.appIds),
        localOnlyReason: undefined,
        localOnlyAuto: undefined,
      },
      hits,
      conflictsWithChoice: false,
    };
  }
  return { patch: null, hits, conflictsWithChoice: false };
}

/** Detect desktop-only hits for a job, including "runs another desktop-only job's code". */
export async function assessJobDesktopOnly(
  job: JobRecord,
  jobDir: string,
  lookup: (jobId: string) => JobRecord | undefined,
): Promise<DesktopOnlyHit[]> {
  const files = await collectJobCodeFiles(jobDir);
  const input = { id: job.id, type: job.type, command: job.command, provider: job.provider, files };
  const hits = detectJobDesktopOnly(input);
  if (!hits.length) {
    for (const ref of referencedJobIds(input)) {
      const other = lookup(ref);
      if (other?.executionCapability === "local-only" && other.localOnlyReason) {
        hits.push({
          kind: "runs-desktop-job",
          reason: DESKTOP_ONLY_REASON["runs-desktop-job"],
          file: "command",
          snippet: `runs ${other.name}'s code (${other.localOnlyReason.toLowerCase()})`,
        });
        break;
      }
    }
  }
  return hits;
}
