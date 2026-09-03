/**
 * Parent-side driver for the out-of-process Turso sync worker.
 *
 * Owns one child process for the whole gateway. Requests run one at a time: the worker opens
 * the replica, syncs, and closes it before replying, which keeps the "one sync engine per
 * replica path" invariant even though two processes are involved.
 *
 * A native panic kills the child rather than the app. In-flight requests are rejected with
 * {@link TursoSyncWorkerCrashError} so the caller can repair the replica and retry; the next
 * request spawns a fresh worker.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TursoSyncWorkerCrashError,
  type TursoSyncWorkerOp,
  type TursoSyncWorkerRequest,
  type TursoSyncWorkerResponse,
} from "./tursoReplicaSyncWorkerProtocol.js";

const WORKER_BOOT_TIMEOUT_MS = 20_000;
const STDERR_RING_BYTES = 4_000;
/**
 * An abort dumps a full native + JS stack across many chunks. Forward the first few for
 * diagnosis and keep the rest in the ring buffer only, so one crash cannot flood the log.
 */
const STDERR_LOG_CHUNK_LIMIT = 5;

export interface TursoSyncWorkerCommand {
  command: string;
  args: string[];
}

export interface RunSyncOptions {
  op: TursoSyncWorkerOp;
  localPath: string;
  tursoUrl: string;
  authToken: string;
  clientName?: string;
  bootstrapIfEmpty: boolean;
  timeoutMs: number;
}

interface PendingRequest {
  op: TursoSyncWorkerOp;
  localPath: string;
  resolve: (pulled: boolean) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function defaultWorkerCommand(): TursoSyncWorkerCommand {
  // The gateway always runs from dist/, so the compiled worker is a sibling of this module.
  const entry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "tursoReplicaSyncWorkerEntry.js",
  );
  // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it a plain Node
  // runtime with the same ABI the native module was built against.
  return { command: process.execPath, args: [entry] };
}

export class TursoReplicaSyncWorkerClient {
  private child: ChildProcess | null = null;
  private booted: Promise<void> | null = null;
  private stdoutBuffer = "";
  private stderrRing = "";
  private shuttingDown = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly resolveCommand: () => TursoSyncWorkerCommand = defaultWorkerCommand,
  ) {}

  async runSync(options: RunSyncOptions): Promise<boolean> {
    await this.ensureBooted();
    const child = this.child;
    if (!child?.stdin?.writable) {
      throw new Error("Turso sync worker is not writable");
    }

    const id = randomUUID();
    const request: TursoSyncWorkerRequest = {
      id,
      op: options.op,
      localPath: options.localPath,
      tursoUrl: options.tursoUrl,
      authToken: options.authToken,
      clientName: options.clientName,
      bootstrapIfEmpty: options.bootstrapIfEmpty,
    };

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A wedged engine can hang instead of aborting; drop the worker so the next
        // request starts clean rather than queueing behind it forever.
        this.killChild("SIGKILL");
        reject(
          new Error(
            `Turso sync worker ${options.op} timed out after ${options.timeoutMs}ms ` +
              `on ${options.localPath}`,
          ),
        );
      }, options.timeoutMs);

      this.pending.set(id, {
        op: options.op,
        localPath: options.localPath,
        resolve,
        reject,
        timer,
      });

      try {
        child.stdin?.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.rejectAllPending(new Error("Turso sync worker shutting down"));
    this.killChild("SIGTERM");
    this.child = null;
    this.booted = null;
    this.shuttingDown = false;
  }

  isRunning(): boolean {
    return this.child !== null && this.child.killed !== true;
  }

  private killChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (child && child.killed !== true) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  private ensureBooted(): Promise<void> {
    if (this.booted) {
      return this.booted;
    }

    this.booted = new Promise<void>((resolve, reject) => {
      const { command, args } = this.resolveCommand();
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      this.child = child;
      this.stdoutBuffer = "";
      this.stderrRing = "";

      let settled = false;
      const bootTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.killChild("SIGKILL");
        reject(new Error("Turso sync worker boot timed out"));
      }, WORKER_BOOT_TIMEOUT_MS);

      const onReady = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(bootTimer);
        resolve();
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        this.consumeStdout(chunk.toString("utf8"), onReady);
      });

      let stderrChunksLogged = 0;
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.stderrRing = (this.stderrRing + text).slice(-STDERR_RING_BYTES);
        if (text.trim().length === 0) {
          return;
        }
        stderrChunksLogged += 1;
        if (stderrChunksLogged <= STDERR_LOG_CHUNK_LIMIT) {
          console.warn("[TursoSyncWorker]", text.trim().slice(0, 300));
        } else if (stderrChunksLogged === STDERR_LOG_CHUNK_LIMIT + 1) {
          console.warn(
            "[TursoSyncWorker] further worker stderr suppressed; tail is included in the crash error",
          );
        }
      });

      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(bootTimer);
          reject(error);
        }
        this.handleChildGone(null, null);
      });

      child.on("close", (code, signal) => {
        clearTimeout(bootTimer);
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `Turso sync worker exited during boot (code=${code}, signal=${signal})`,
            ),
          );
        }
        this.handleChildGone(code, signal);
      });
    }).catch((error: unknown) => {
      this.child = null;
      this.booted = null;
      throw error;
    });

    return this.booted;
  }

  private consumeStdout(text: string, onReady: () => void): void {
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.dispatchLine(line, onReady);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string, onReady: () => void): void {
    let parsed: (TursoSyncWorkerResponse & { ready?: boolean }) | null = null;
    try {
      parsed = JSON.parse(line) as TursoSyncWorkerResponse & {
        ready?: boolean;
      };
    } catch {
      // Anything the SDK prints on stdout would land here; ignore rather than desync.
      return;
    }

    if (parsed?.ready === true) {
      onReady();
      return;
    }

    const id = typeof parsed?.id === "string" ? parsed.id : null;
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (parsed.ok === true) {
      pending.resolve(Boolean(parsed.pulled));
    } else {
      pending.reject(new Error(parsed.error || "Turso sync worker error"));
    }
  }

  /**
   * The child is gone. Anything still in flight died with it — surface that as a crash so
   * callers can distinguish "the engine aborted" from "sync returned an error".
   */
  private handleChildGone(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.child = null;
    this.booted = null;
    this.stdoutBuffer = "";

    if (this.shuttingDown || this.pending.size === 0) {
      this.pending.clear();
      return;
    }

    const stderr = this.stderrRing;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(
        new TursoSyncWorkerCrashError({
          op: pending.op,
          localPath: pending.localPath,
          exitCode: code,
          signal,
          stderr,
        }),
      );
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

let clientInstance: TursoReplicaSyncWorkerClient | null = null;

export function getTursoReplicaSyncWorkerClient(): TursoReplicaSyncWorkerClient {
  if (!clientInstance) {
    clientInstance = new TursoReplicaSyncWorkerClient();
  }
  return clientInstance;
}

export async function shutdownTursoReplicaSyncWorker(): Promise<void> {
  if (!clientInstance) {
    return;
  }
  await clientInstance.shutdown();
  clientInstance = null;
}
