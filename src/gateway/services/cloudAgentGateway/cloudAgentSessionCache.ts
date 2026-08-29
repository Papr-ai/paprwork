/**
 * In-process cache of warm cloud agent workspaces (app-agent chat sessions).
 */

import fs from "fs/promises";
import {
  beginCloudAgentRun,
  resolveCloudRunRoot,
  type CloudRunHandle,
} from "./cloudAgentRunContext.js";
import type {
  CloudAgentRunRequest,
  CloudAgentSessionBeginResponse,
} from "./types.js";
import {
  CLOUD_AGENT_SESSION_MAX_ENTRIES,
  CLOUD_AGENT_SESSION_TTL_MS,
} from "./types.js";

interface CachedCloudAgentSession {
  sessionId: string;
  runRoot: string;
  paprHome: string;
  jobId: string;
  userId: string;
  orgId: string;
  request: CloudAgentRunRequest;
  expiresAt: number;
  warming?: Promise<CloudAgentSessionBeginResponse>;
}

let sharedCache: CloudAgentSessionCache | undefined;

export class CloudAgentSessionCache {
  private readonly entries = new Map<string, CachedCloudAgentSession>();
  private readonly turnLocks = new Map<string, Promise<void>>();

  async beginSession(
    request: CloudAgentRunRequest,
  ): Promise<CloudAgentSessionBeginResponse> {
    const sessionId = request.workspaceSessionId;
    if (!sessionId) {
      throw new Error("workspaceSessionId is required to begin a warm session");
    }

    this.pruneExpired();

    const existing = this.entries.get(sessionId);
    if (existing && this.isCompatible(existing, request)) {
      if (Date.now() < existing.expiresAt) {
        existing.expiresAt = Date.now() + CLOUD_AGENT_SESSION_TTL_MS;
        return {
          status: "ready",
          sessionId,
          expiresAt: new Date(existing.expiresAt).toISOString(),
        };
      }
      await this.endSession(sessionId);
    } else if (existing && !this.isCompatible(existing, request)) {
      await this.endSession(sessionId);
    }

    const warmingEntry = this.entries.get(sessionId);
    if (warmingEntry?.warming) {
      return warmingEntry.warming;
    }

    const warming = this.warmSessionOnDisk(request, sessionId);
    const prior = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      sessionId,
      runRoot: resolveCloudRunRoot(request),
      paprHome: prior?.paprHome ?? "",
      jobId: request.jobId,
      userId: request.userId,
      orgId: request.orgId,
      request,
      expiresAt: Date.now() + CLOUD_AGENT_SESSION_TTL_MS,
      warming,
    });

    return warming;
  }

  async acquireForTurn(request: CloudAgentRunRequest): Promise<CloudRunHandle> {
    const sessionId = request.workspaceSessionId;
    if (!sessionId) {
      return beginCloudAgentRun(request);
    }

    await this.beginSession(request);
    const entry = this.entries.get(sessionId);
    if (!entry) {
      throw new Error(`Warm session ${sessionId} is not available`);
    }

    const runRoot = entry.runRoot;
    const paprHome = entry.paprHome || `${runRoot}/Papr`;
    entry.paprHome = paprHome;
    entry.expiresAt = Date.now() + CLOUD_AGENT_SESSION_TTL_MS;

    const handle = await beginCloudAgentRun(request, {
      skipClone: true,
      runRoot,
    });

    return {
      runRoot: handle.runRoot,
      paprHome: handle.paprHome,
      tursoTargets: handle.tursoTargets,
      finish: async (options?: { deleteWorkspace?: boolean; prepOnly?: boolean }) => {
        const keepWarm = options?.deleteWorkspace === false;
        await handle.finish({
          deleteWorkspace: !keepWarm,
          ...(options?.prepOnly ? { prepOnly: true } : {}),
        });
        if (keepWarm) {
          entry.expiresAt = Date.now() + CLOUD_AGENT_SESSION_TTL_MS;
        } else {
          this.entries.delete(sessionId);
        }
      },
    };
  }

  /** Serialize turns for the same warm session (one stream at a time). */
  async acquireTurnLock(sessionId: string): Promise<() => void> {
    const previous = this.turnLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.turnLocks.set(sessionId, current);
    await previous;
    return () => {
      release();
    };
  }

  async endSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }
    this.entries.delete(sessionId);
    await fs.rm(entry.runRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  private async warmSessionOnDisk(
    request: CloudAgentRunRequest,
    sessionId: string,
  ): Promise<CloudAgentSessionBeginResponse> {
    const runRoot = resolveCloudRunRoot(request);
    const paprHome = `${runRoot}/Papr`;
    let skipClone = false;
    try {
      await fs.access(paprHome);
      skipClone = true;
    } catch {
      skipClone = false;
    }

    const handle = await beginCloudAgentRun(request, { skipClone, runRoot, prepOnly: true });
    await handle.finish({ deleteWorkspace: false, prepOnly: true });

    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.paprHome = paprHome;
      entry.runRoot = runRoot;
      entry.request = request;
      entry.expiresAt = Date.now() + CLOUD_AGENT_SESSION_TTL_MS;
      entry.warming = undefined;
    } else {
      this.entries.set(sessionId, {
        sessionId,
        runRoot,
        paprHome,
        jobId: request.jobId,
        userId: request.userId,
        orgId: request.orgId,
        request,
        expiresAt: Date.now() + CLOUD_AGENT_SESSION_TTL_MS,
      });
    }

    this.evictIfOverCapacity();

    return {
      status: "ready",
      sessionId,
      expiresAt: new Date(Date.now() + CLOUD_AGENT_SESSION_TTL_MS).toISOString(),
    };
  }

  private isCompatible(
    entry: CachedCloudAgentSession,
    request: CloudAgentRunRequest,
  ): boolean {
    return (
      entry.jobId === request.jobId &&
      entry.userId === request.userId &&
      entry.orgId === request.orgId
    );
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now && !entry.warming) {
        void this.endSession(sessionId);
      }
    }
  }

  private evictIfOverCapacity(): void {
    if (this.entries.size <= CLOUD_AGENT_SESSION_MAX_ENTRIES) {
      return;
    }
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    const overflow = this.entries.size - CLOUD_AGENT_SESSION_MAX_ENTRIES;
    for (let index = 0; index < overflow; index += 1) {
      const [sessionId] = sorted[index] ?? [];
      if (sessionId) {
        void this.endSession(sessionId);
      }
    }
  }
}

export function getCloudAgentSessionCache(): CloudAgentSessionCache {
  if (!sharedCache) {
    sharedCache = new CloudAgentSessionCache();
  }
  return sharedCache;
}

/** Test-only reset. */
export function resetCloudAgentSessionCacheForTests(): void {
  sharedCache = undefined;
}
