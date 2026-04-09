import { promises as fs } from "fs";
import path from "path";
import os from "os";

export interface JobRunHistoryEntry {
  runId: string; // e.g., "job-123-1774591984-a1"
  jobId: string;
  status: "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  duration?: number; // milliseconds
  exitCode?: number;
  error?: string;
  scheduledDueAt?: string; // If triggered by scheduler
  attempt: number;
  maxAttempts: number;
}

export class JobRunHistory {
  private historyPath: string;
  private maxBytes: number;
  private keepLines: number;

  constructor(
    dataDir?: string,
    maxBytes: number = 5_000_000, // 5MB default
    keepLines: number = 5000, // Keep last 5000 runs
  ) {
    const paprRoot = dataDir ?? path.join(os.homedir(), "Papr");
    this.historyPath = path.join(paprRoot, "data", "job-runs.jsonl");
    this.maxBytes = maxBytes;
    this.keepLines = keepLines;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    // Create file if it doesn't exist
    try {
      await fs.access(this.historyPath);
    } catch {
      await fs.writeFile(this.historyPath, "", "utf8");
    }
  }

  async appendRun(entry: JobRunHistoryEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.historyPath, line, "utf8");

    // Check if pruning is needed
    const stats = await fs.stat(this.historyPath);
    if (stats.size > this.maxBytes) {
      await this.pruneOldRuns();
    }
  }

  async getRunsForJob(
    jobId: string,
    limit?: number,
  ): Promise<JobRunHistoryEntry[]> {
    try {
      const content = await fs.readFile(this.historyPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);

      const entries: JobRunHistoryEntry[] = [];
      // Read from end (newest first)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as JobRunHistoryEntry;
          if (entry.jobId === jobId) {
            entries.push(entry);
            if (limit && entries.length >= limit) {
              break;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  async getAllRuns(limit?: number): Promise<JobRunHistoryEntry[]> {
    try {
      const content = await fs.readFile(this.historyPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);

      const entries: JobRunHistoryEntry[] = [];
      // Read from end (newest first)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as JobRunHistoryEntry;
          entries.push(entry);
          if (limit && entries.length >= limit) {
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  async getStats(jobId: string): Promise<{
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    avgDuration: number | null;
    lastRunAt: string | null;
  }> {
    const runs = await this.getRunsForJob(jobId);

    const completed = runs.filter((r) => r.status === "completed");
    const failed = runs.filter((r) => r.status === "failed");
    const cancelled = runs.filter((r) => r.status === "cancelled");

    const durationsMs = completed
      .map((r) => r.duration)
      .filter((d): d is number => d !== undefined);

    const avgDuration =
      durationsMs.length > 0
        ? durationsMs.reduce((sum, d) => sum + d, 0) / durationsMs.length
        : null;

    const lastRunAt =
      runs.length > 0 ? runs[0].completedAt ?? runs[0].startedAt : null;

    return {
      totalRuns: runs.length,
      completedRuns: completed.length,
      failedRuns: failed.length,
      cancelledRuns: cancelled.length,
      avgDuration,
      lastRunAt,
    };
  }

  private async pruneOldRuns(): Promise<void> {
    try {
      const content = await fs.readFile(this.historyPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);

      if (lines.length <= this.keepLines) {
        return; // Nothing to prune
      }

      // Keep only the last N lines (newest runs)
      const keep = lines.slice(-this.keepLines);
      await fs.writeFile(this.historyPath, keep.join("\n") + "\n", "utf8");

      console.log(
        `[JobRunHistory] Pruned to ${this.keepLines} lines (was ${lines.length})`,
      );
    } catch (error) {
      console.error("[JobRunHistory] Failed to prune:", error);
    }
  }
}

let jobRunHistoryInstance: JobRunHistory | null = null;

export function getJobRunHistory(): JobRunHistory {
  if (!jobRunHistoryInstance) {
    jobRunHistoryInstance = new JobRunHistory();
  }
  return jobRunHistoryInstance;
}
