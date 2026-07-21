/**
 * Dedupe cloud gateway pre-warm requests per chat session (cost control).
 */

import type { AppAgentWarmStatus } from "../../../core/types/appAgentChat.js";

const READY_TTL_MS = 15 * 60 * 1000;
const FAILED_COOLDOWN_MS = 30 * 1000;

interface WarmEntry {
  status: AppAgentWarmStatus;
  updatedAt: number;
  expiresAt?: number;
  message?: string;
  inFlight?: Promise<AppAgentWarmStatus>;
}

let sharedCoordinator: AppAgentChatWarmCoordinator | undefined;

export class AppAgentChatWarmCoordinator {
  private readonly entries = new Map<string, WarmEntry>();

  getStatus(sessionId: string): AppAgentWarmStatus {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return "idle";
    }
    this.pruneIfExpired(sessionId, entry);
    const current = this.entries.get(sessionId);
    return current?.status ?? "idle";
  }

  getSnapshot(sessionId: string): {
    status: AppAgentWarmStatus;
    expiresAt?: string;
    message?: string;
  } {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return { status: "idle" };
    }
    this.pruneIfExpired(sessionId, entry);
    const current = this.entries.get(sessionId);
    if (!current) {
      return { status: "idle" };
    }
    return {
      status: current.status,
      ...(current.expiresAt
        ? { expiresAt: new Date(current.expiresAt).toISOString() }
        : {}),
      ...(current.message ? { message: current.message } : {}),
    };
  }

  async ensureWarm(
    sessionId: string,
    warm: () => Promise<{ status: "ready" | "warming"; expiresAt?: string } | "unavailable">,
  ): Promise<AppAgentWarmStatus> {
    const existing = this.entries.get(sessionId);
    if (existing) {
      this.pruneIfExpired(sessionId, existing);
    }

    const entry = this.entries.get(sessionId);
    if (entry?.status === "ready") {
      return "ready";
    }
    if (entry?.status === "warming" && entry.inFlight) {
      return entry.inFlight;
    }
    if (entry?.status === "failed") {
      const retryAfter = entry.updatedAt + FAILED_COOLDOWN_MS;
      if (Date.now() < retryAfter) {
        return "failed";
      }
    }
    if (entry?.status === "unavailable") {
      return "unavailable";
    }

    const inFlight = (async (): Promise<AppAgentWarmStatus> => {
      this.entries.set(sessionId, {
        status: "warming",
        updatedAt: Date.now(),
      });

      try {
        const result = await warm();
        if (result === "unavailable") {
          this.entries.set(sessionId, {
            status: "unavailable",
            updatedAt: Date.now(),
            message: "Gateway pre-warm is not available on this server yet.",
          });
          return "unavailable";
        }

        const expiresAtMs = result.expiresAt
          ? Date.parse(result.expiresAt)
          : Date.now() + READY_TTL_MS;
        this.entries.set(sessionId, {
          status: result.status,
          updatedAt: Date.now(),
          expiresAt:
            result.status === "ready" && Number.isFinite(expiresAtMs)
              ? expiresAtMs
              : undefined,
        });
        return result.status;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.entries.set(sessionId, {
          status: "failed",
          updatedAt: Date.now(),
          message,
        });
        return "failed";
      }
    })();

    this.entries.set(sessionId, {
      status: "warming",
      updatedAt: Date.now(),
      inFlight,
    });

    const finalStatus = await inFlight;
    const done = this.entries.get(sessionId);
    if (done) {
      this.entries.set(sessionId, {
        status: finalStatus,
        updatedAt: Date.now(),
        expiresAt:
          finalStatus === "ready"
            ? done.expiresAt ?? Date.now() + READY_TTL_MS
            : done.expiresAt,
        message: done.message,
      });
    }
    return finalStatus;
  }

  markReady(sessionId: string): void {
    this.entries.set(sessionId, {
      status: "ready",
      updatedAt: Date.now(),
      expiresAt: Date.now() + READY_TTL_MS,
    });
  }

  private pruneIfExpired(sessionId: string, entry: WarmEntry): void {
    if (entry.status === "ready" && entry.expiresAt && Date.now() > entry.expiresAt) {
      this.entries.delete(sessionId);
    }
  }
}

export function getAppAgentChatWarmCoordinator(): AppAgentChatWarmCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = new AppAgentChatWarmCoordinator();
  }
  return sharedCoordinator;
}
