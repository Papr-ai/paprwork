/**
 * Parent-side driver for the Turso sync worker.
 *
 * Owns one child process for the whole gateway. The child is the only process that loads
 * `@tursodatabase/sync`; it keeps a Database handle per replica path and serves every
 * replica operation over NDJSON.
 *
 * A native panic kills the child rather than the app. In-flight requests are rejected with
 * {@link TursoSyncWorkerCrashError}; the next request spawns a fresh worker. Crash policy
 * (sidecar reset + one retry) lives in `send()` so every caller gets it for free.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDEMPOTENT_WORKER_OPS,
  TursoSyncWorkerCrashError,
  isTursoSyncWorkerCrash,
  type TursoSyncWorkerLine,
  type TursoSyncWorkerOp,
  type TursoSyncWorkerOpenSpec,
  type TursoSyncWorkerPullResult,
  type TursoSyncWorkerQueryResult,
  type TursoSyncWorkerRequest,
  type TursoSyncWorkerResult,
  type TursoSyncWorkerStatement,
  type TursoSyncWorkerStatsResult,
  type TursoSyncWorkerWriteResult,
} from "./tursoReplicaSyncWorkerProtocol.js";
import { resetReplicaSidecars } from "./tursoReplicaSidecarWedge.js";

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

export interface SendOptions extends TursoSyncWorkerOpenSpec {
  op: TursoSyncWorkerOp;
  timeoutMs: number;
  sql?: string;
  params?: unknown[];
  statements?: TursoSyncWorkerStatement[];
  /**
   * Override the default crash policy (retry idempotent ops once after a sidecar reset).
   * `never`: surface the crash immediately.
   */
  retryOnCrash?: "auto" | "never";
}

interface PendingRequest {
  op: TursoSyncWorkerOp;
  localPath: string;
  started: boolean;
  resolve: (result: TursoSyncWorkerResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Called on every worker crash. Wire telemetry here — this is the one place crashes surface. */
export type TursoSyncWorkerCrashListener = (error: TursoSyncWorkerCrashError) => void;

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
  private readonly crashListeners = new Set<TursoSyncWorkerCrashListener>();

  constructor(
    private readonly resolveCommand: () => TursoSyncWorkerCommand = defaultWorkerCommand,
  ) {}

  onCrash(listener: TursoSyncWorkerCrashListener): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  // ---- typed helpers -------------------------------------------------------------------

  async query(
    options: Omit<SendOptions, "op" | "statements">,
  ): Promise<TursoSyncWorkerQueryResult> {
    return (await this.send({ ...options, op: "query" })) as TursoSyncWorkerQueryResult;
  }

  async write(
    options: Omit<SendOptions, "op" | "sql" | "params">,
  ): Promise<TursoSyncWorkerWriteResult> {
    return (await this.send({ ...options, op: "write" })) as TursoSyncWorkerWriteResult;
  }

  async exec(options: Omit<SendOptions, "op" | "params" | "statements">): Promise<void> {
    await this.send({ ...options, op: "exec" });
  }

  async sync(
    options: Omit<SendOptions, "op" | "sql" | "params" | "statements">,
    op: "pull" | "push" | "pullPush",
  ): Promise<boolean> {
    const result = (await this.send({ ...options, op })) as TursoSyncWorkerPullResult;
    return Boolean(result.pulled);
  }

  async stats(
    options: Omit<SendOptions, "op" | "sql" | "params" | "statements">,
  ): Promise<number> {
    const result = (await this.send({ ...options, op: "stats" })) as TursoSyncWorkerStatsResult;
    return Number(result.cdcOperations ?? 0);
  }

  async connect(
    options: Omit<SendOptions, "op" | "sql" | "params" | "statements">,
  ): Promise<void> {
    await this.send({ ...options, op: "connect" });
  }

  async close(localPath: string): Promise<void> {
    if (!this.child) {
      return;
    }
    await this.send({
      op: "close",
      localPath,
      tursoUrl: "",
      authToken: "",
      bootstrapIfEmpty: false,
      timeoutMs: 10_000,
      retryOnCrash: "never",
    });
  }

  // ---- core ----------------------------------------------------------------------------

  /**
   * Send one request. On a worker crash where the engine was operating on this path:
   * reset the path's sync sidecars (keeps data.db), then retry once if the op is idempotent.
   * Anything else surfaces as an error to the caller. The gateway never dies here.
   */
  async send(options: SendOptions): Promise<TursoSyncWorkerResult> {
    try {
      return await this.sendOnce(options);
    } catch (error) {
      if (!isTursoSyncWorkerCrash(error)) {
        throw error;
      }
      if (error.engineWasRunning) {
        console.warn(
          `[TursoSyncWorker] Engine crashed during ${error.op} on ${error.localPath} — ` +
            `resetting sync sidecars. ${error.stderrTail.slice(-200)}`,
        );
        resetReplicaSidecars(error.localPath);
      }
      const retry =
        (options.retryOnCrash ?? "auto") === "auto" &&
        IDEMPOTENT_WORKER_OPS.has(options.op);
      if (!retry) {
        throw error;
      }
      return await this.sendOnce(options);
    }
  }

  private async sendOnce(options: SendOptions): Promise<TursoSyncWorkerResult> {
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
      sql: options.sql,
      params: options.params,
      statements: options.statements,
    };

    return new Promise<TursoSyncWorkerResult>((resolve, reject) => {
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
        started: false,
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
    let parsed: TursoSyncWorkerLine | null = null;
    try {
      parsed = JSON.parse(line) as TursoSyncWorkerLine;
    } catch {
      // Anything the SDK prints on stdout would land here; ignore rather than desync.
      return;
    }

    if ("ready" in parsed && parsed.ready === true) {
      onReady();
      return;
    }

    const id = "id" in parsed && typeof parsed.id === "string" ? parsed.id : null;
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    if ("started" in parsed) {
      pending.started = true;
      return;
    }
    if (!("ok" in parsed)) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (parsed.ok === true) {
      pending.resolve(parsed.result ?? {});
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
      const error = new TursoSyncWorkerCrashError({
        op: pending.op,
        localPath: pending.localPath,
        exitCode: code,
        signal,
        engineWasRunning: pending.started,
        stderr,
      });
      for (const listener of this.crashListeners) {
        try {
          listener(error);
        } catch {
          /* listener must not break recovery */
        }
      }
      pending.reject(error);
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

/**
 * Report a worker crash to Amplitude. This is the only place engine panics become visible
 * in the field — before the worker split they took the gateway down silently.
 * No paths or user data: just the op, how it died, and the panic signature.
 */
function reportWorkerCrash(error: TursoSyncWorkerCrashError): void {
  void import("../gatewayTelemetry.js")
    .then(({ getGatewayTelemetry }) =>
      import("../../../core/telemetry/events.js").then(({ AmplitudeEvents }) => {
        getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.TURSO_SYNC_WORKER_CRASH, {
          op: error.op,
          signal: error.signal ?? "",
          exit_code: error.exitCode ?? -1,
          engine_was_running: error.engineWasRunning,
          // First line of the Rust panic message, e.g. "thread '<unnamed>' panicked at ..."
          panic_signature: extractPanicSignature(error.stderrTail),
        });
      }),
    )
    .catch(() => {
      /* telemetry must never break recovery */
    });
}

function extractPanicSignature(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => l.trim());
  const line =
    lines.find((l) => /panicked at|assertion|unwrap\(\)|index out of bounds/i.test(l)) ??
    lines[lines.length - 1] ??
    "";
  return line.trim().slice(0, 200);
}

export function getTursoReplicaSyncWorkerClient(): TursoReplicaSyncWorkerClient {
  if (!clientInstance) {
    clientInstance = new TursoReplicaSyncWorkerClient();
    clientInstance.onCrash(reportWorkerCrash);
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
