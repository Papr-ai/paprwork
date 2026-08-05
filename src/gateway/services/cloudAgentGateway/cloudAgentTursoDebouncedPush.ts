/**
 * Debounced Turso push during cloud agent runs — watches sandbox SQLite files
 * and pushes deltas to Turso without waiting for job completion.
 */

import path from "path";
import chokidar, { type FSWatcher } from "chokidar";
import { ensureLocalDbChangeLogReady } from "../tursoSyncBridgeCore.js";
import {
  pushLinkedSourceToCloud,
  type TursoBookendTarget,
} from "./syncJobTursoBookends.js";
import { notifyCloudDbChangedForTarget } from "./cloudTursoPushHelpers.js";

const DEFAULT_DEBOUNCE_MS = 15_000;

function debounceMs(): number {
  const raw = process.env.CLOUD_AGENT_TURSO_DEBOUNCE_MS;
  if (!raw) {
    return DEFAULT_DEBOUNCE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
}

function normalizePath(filePath: string): string {
  return path.normalize(filePath);
}

/** SQLite main file or WAL sidecar under a watched data directory. */
export function isCloudTursoSqliteFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return (
    base.endsWith(".db") ||
    base.endsWith(".db-wal") ||
    base.endsWith(".db-shm")
  );
}

export interface CloudTursoDebouncedPushHandle {
  /** Cancel pending timers and push all targets now. */
  flush(): Promise<void>;
  /** Stop file watcher (call before flush at run end). */
  stop(): Promise<void>;
}

export async function startCloudAgentTursoDebouncedPush(
  targets: TursoBookendTarget[],
): Promise<CloudTursoDebouncedPushHandle | undefined> {
  if (targets.length === 0) {
    return undefined;
  }

  const dirToTarget = new Map<string, TursoBookendTarget>();
  for (const target of targets) {
    const dataDir = path.dirname(normalizePath(target.dbPath));
    if (!dirToTarget.has(dataDir)) {
      dirToTarget.set(dataDir, target);
    }
  }

  const watchDirs = [...dirToTarget.keys()];
  if (watchDirs.length === 0) {
    return undefined;
  }

  const pendingTimers = new Map<string, NodeJS.Timeout>();
  const pushInFlight = new Map<string, Promise<void>>();
  let watcher: FSWatcher | null = null;
  let stopped = false;

  async function executePush(target: TursoBookendTarget): Promise<void> {
    const existing = pushInFlight.get(target.syncKey);
    if (existing) {
      await existing;
      return;
    }

    const pushPromise = (async () => {
      try {
        ensureLocalDbChangeLogReady(target.dbPath);
      } catch (error) {
        console.warn(
          `[CloudTursoDebouncedPush] Changelog setup failed for ${target.syncKey}:`,
          (error as Error).message,
        );
        return;
      }

      try {
        const result = await pushLinkedSourceToCloud(target);
        if (result.status === "pushed") {
          const mode = result.syncMode ?? "unknown";
          console.log(
            `[CloudTursoDebouncedPush] Pushed ${target.syncKey} (${result.tables.length} table(s), mode=${mode})`,
          );
          await notifyCloudDbChangedForTarget(target, result);
        } else if (result.reason !== "all_tables_unchanged") {
          console.warn(
            `[CloudTursoDebouncedPush] Push skipped for ${target.syncKey}: ${result.reason ?? "unknown"}`,
          );
        }
      } catch (error) {
        console.warn(
          `[CloudTursoDebouncedPush] Push failed for ${target.syncKey}:`,
          (error as Error).message.slice(0, 200),
        );
      }
    })();

    pushInFlight.set(target.syncKey, pushPromise);
    try {
      await pushPromise;
    } finally {
      pushInFlight.delete(target.syncKey);
    }
  }

  function schedulePush(target: TursoBookendTarget): void {
    if (stopped) {
      return;
    }

    const existing = pendingTimers.get(target.syncKey);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      pendingTimers.delete(target.syncKey);
      void executePush(target);
    }, debounceMs());

    pendingTimers.set(target.syncKey, timer);
  }

  function handleDbChange(changedPath: string): void {
    if (!isCloudTursoSqliteFile(changedPath)) {
      return;
    }
    const target = dirToTarget.get(path.dirname(normalizePath(changedPath)));
    if (!target) {
      return;
    }
    schedulePush(target);
  }

  watcher = chokidar.watch(watchDirs, {
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 250 },
  });

  watcher
    .on("add", handleDbChange)
    .on("change", handleDbChange)
    .on("unlink", handleDbChange);

  await new Promise<void>((resolve, reject) => {
    watcher!.once("ready", () => resolve());
    watcher!.once("error", (err) => reject(err));
  });

  console.log(
    `[CloudTursoDebouncedPush] Watching ${watchDirs.length} sandbox DB dir(s), debounce=${debounceMs()}ms`,
  );

  return {
    async flush(): Promise<void> {
      for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
      }
      pendingTimers.clear();

      for (const target of targets) {
        await executePush(target);
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
      }
      pendingTimers.clear();

      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },
  };
}
