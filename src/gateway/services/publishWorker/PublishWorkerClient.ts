/**
 * Gateway side of the publish worker (see publishWorkerEntry.ts).
 *
 * - Spawns one child lazily; many apps upload through it at once.
 * - Streams step labels back so the share chip shows live progress.
 * - A crash or a hung request (> REQUEST_TIMEOUT_MS) kills the child, fails
 *   only the uploads it was running, puts their orphaned outbox entries back
 *   to pending, and the next publish respawns it.
 * - getStatus() feeds /api/debug/gateway-performance.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PublishWorkerError,
  PublishWorkerLine,
  PublishWorkerPushRequest,
} from "./publishWorkerProtocol.js";

type OkLine = Extract<PublishWorkerLine, { ok: true }>;

/** Writer fetch times out at 300s; leave room for outbox replay + hashing. */
const REQUEST_TIMEOUT_MS = Number(process.env.PAPR_PUBLISH_WORKER_TIMEOUT_MS ?? 420_000);
const BOOT_TIMEOUT_MS = 20_000;
const MAX_RECENT = 30;

export class PublishWorkerRequestError extends Error {
  constructor(readonly detail: PublishWorkerError) {
    super(detail.message);
    this.name = detail.name;
  }
}

interface Pending {
  appId: string;
  startedAt: number;
  label?: string;
  onProgress?: (label: string, detail?: string) => void;
  resolve: (line: OkLine) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PublishWorkerCommand {
  command: string;
  args: string[];
}

function defaultCommand(): PublishWorkerCommand {
  const entry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "publishWorkerEntry.js",
  );
  return { command: process.execPath, args: [entry] };
}

export class PublishWorkerClient {
  private child: ChildProcess | null = null;
  private booted: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private stdoutBuffer = "";
  private restarts = 0;
  private lastCrash: { at: string; reason: string } | null = null;
  private readonly recent: Array<{
    appId: string;
    ok: boolean;
    durationMs: number;
    finishedAt: string;
    error?: string;
  }> = [];

  constructor(
    private readonly resolveCommand: () => PublishWorkerCommand = defaultCommand,
  ) {}

  push(
    request: Omit<PublishWorkerPushRequest, "id" | "kind">,
    onProgress?: (label: string, detail?: string) => void,
  ): Promise<OkLine> {
    return this.ensureBooted().then(
      () =>
        new Promise<OkLine>((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            this.crash(`upload for ${request.appId} exceeded ${REQUEST_TIMEOUT_MS / 1000}s`);
          }, REQUEST_TIMEOUT_MS);
          this.pending.set(id, {
            appId: request.appId,
            startedAt: Date.now(),
            onProgress,
            resolve,
            reject,
            timer,
          });
          const line: PublishWorkerPushRequest = { ...request, id, kind: "push-writer-ops" };
          this.child?.stdin?.write(`${JSON.stringify(line)}\n`);
        }),
    );
  }

  getStatus() {
    const now = Date.now();
    return {
      pid: this.child?.pid ?? null,
      running: this.child !== null,
      restarts: this.restarts,
      lastCrash: this.lastCrash,
      inFlight: [...this.pending.values()].map((p) => ({
        appId: p.appId,
        label: p.label ?? null,
        elapsedMs: now - p.startedAt,
      })),
      recent: [...this.recent],
    };
  }

  /** Test hook / shutdown. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.booted = null;
    child?.stdin?.end();
    child?.kill("SIGTERM");
  }

  private ensureBooted(): Promise<void> {
    if (this.booted) return this.booted;
    this.booted = new Promise<void>((resolve, reject) => {
      const { command, args } = this.resolveCommand();
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      this.child = child;
      this.stdoutBuffer = "";
      let ready = false;
      const bootTimer = setTimeout(() => {
        if (!ready) {
          this.crash("worker boot timed out");
          reject(new Error("Publish worker boot timed out"));
        }
      }, BOOT_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
          const raw = this.stdoutBuffer.slice(0, nl).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
          if (!raw) continue;
          let line: PublishWorkerLine;
          try {
            line = JSON.parse(raw) as PublishWorkerLine;
          } catch {
            continue;
          }
          if ("ready" in line) {
            ready = true;
            clearTimeout(bootTimer);
            resolve();
            continue;
          }
          this.handleLine(line);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const text of chunk.toString("utf8").split("\n")) {
          if (text.trim()) console.log(`[PublishWorker] ${text}`);
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(bootTimer);
        if (this.child !== child) return; // already replaced / stopped
        this.crash(`exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
        if (!ready) reject(new Error("Publish worker exited during boot"));
      });
      child.on("error", (err) => {
        if (this.child !== child) return;
        this.crash(`spawn error: ${err.message}`);
        if (!ready) reject(err);
      });
    });
    return this.booted;
  }

  private handleLine(line: Exclude<PublishWorkerLine, { ready: true }>): void {
    const pending = this.pending.get(line.id);
    if (!pending) return;
    if ("progress" in line) {
      pending.label = line.progress.label;
      pending.onProgress?.(line.progress.label, line.progress.detail);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(line.id);
    this.remember(pending.appId, line.ok, line.durationMs, line.ok ? undefined : line.error.message);
    if (line.ok) {
      pending.resolve(line);
    } else {
      pending.reject(new PublishWorkerRequestError(line.error));
    }
  }

  private remember(appId: string, ok: boolean, durationMs: number, error?: string): void {
    this.recent.push({ appId, ok, durationMs, finishedAt: new Date().toISOString(), error });
    if (this.recent.length > MAX_RECENT) this.recent.shift();
  }

  /** Kill the child, fail its uploads, requeue their orphaned outbox entries. */
  private crash(reason: string): void {
    const child = this.child;
    this.child = null;
    this.booted = null;
    if (child && child.exitCode === null) child.kill("SIGKILL");
    this.restarts += 1;
    this.lastCrash = { at: new Date().toISOString(), reason };
    const orphaned = [...this.pending.values()];
    this.pending.clear();
    console.warn(`[PublishWorker] ${reason} — failing ${orphaned.length} upload(s)`);
    for (const p of orphaned) {
      clearTimeout(p.timer);
      this.remember(p.appId, false, Date.now() - p.startedAt, reason);
      p.reject(new Error(`Publish worker stopped: ${reason}. Publish again to retry.`));
    }
    if (orphaned.length > 0) {
      void import("../syncV3/SyncOutbox.js")
        .then(({ requeueOrphanedInflightOutboxEntries }) =>
          requeueOrphanedInflightOutboxEntries(orphaned.map((p) => p.appId)),
        )
        .catch((err) =>
          console.warn("[PublishWorker] outbox requeue failed:", (err as Error).message),
        );
    }
  }
}

let instance: PublishWorkerClient | null = null;

export function getPublishWorkerClient(): PublishWorkerClient {
  instance ??= new PublishWorkerClient();
  return instance;
}

export function getPublishWorkerStatusIfStarted() {
  return instance?.getStatus() ?? null;
}

/** Default on; PAPR_PUBLISH_WORKER=0 runs uploads in the gateway (old path). */
export function isPublishWorkerEnabled(): boolean {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return process.env.PAPR_PUBLISH_WORKER === "1";
  }
  return process.env.PAPR_PUBLISH_WORKER !== "0";
}

export function stopPublishWorker(): void {
  instance?.stop();
}
