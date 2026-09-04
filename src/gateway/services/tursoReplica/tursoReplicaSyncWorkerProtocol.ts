/**
 * Wire protocol between the gateway and the Turso sync worker.
 *
 * The worker is the ONLY process that loads `@tursodatabase/sync`. The gateway never
 * touches the native engine — every replica operation (open, read, write, pull, push)
 * is a request over this protocol. A Rust panic therefore kills the worker, not the app.
 *
 * Newline-delimited JSON over stdin/stdout. This module must stay free of any import
 * that pulls in the native module so the parent can import it safely.
 */

export type TursoSyncWorkerOp =
  | "connect" // open (or reuse) the handle; no sync
  | "close" // close the handle if open
  | "query" // prepare + all()
  | "write" // prepare + run() for each statement
  | "exec" // db.exec(sql)
  | "pull"
  | "push"
  | "pullPush"
  | "stats"; // db.stats()

/** Ops that may be transparently re-sent after a worker crash. */
export const IDEMPOTENT_WORKER_OPS: ReadonlySet<TursoSyncWorkerOp> = new Set<TursoSyncWorkerOp>([
  "connect",
  "close",
  "query",
  "pull",
  "push",
  "pullPush",
  "stats",
]);

export interface TursoSyncWorkerStatement {
  sql: string;
  params?: unknown[];
}

export interface TursoSyncWorkerOpenSpec {
  localPath: string;
  tursoUrl: string;
  authToken: string;
  clientName?: string;
  /** Passed through to connect(); false keeps an existing local file authoritative. */
  bootstrapIfEmpty: boolean;
}

export interface TursoSyncWorkerRequest extends TursoSyncWorkerOpenSpec {
  id: string;
  op: TursoSyncWorkerOp;
  /** query / exec */
  sql?: string;
  /** query */
  params?: unknown[];
  /** write */
  statements?: TursoSyncWorkerStatement[];
}

export interface TursoSyncWorkerQueryResult {
  rows: unknown[];
}

export interface TursoSyncWorkerWriteResult {
  changes: number;
  lastInsertRowid: number;
}

export interface TursoSyncWorkerPullResult {
  pulled: boolean;
}

export interface TursoSyncWorkerStatsResult {
  cdcOperations: number;
}

export type TursoSyncWorkerResult =
  | TursoSyncWorkerQueryResult
  | TursoSyncWorkerWriteResult
  | TursoSyncWorkerPullResult
  | TursoSyncWorkerStatsResult
  | Record<string, never>;

/** Emitted just before the worker hands a request to the engine. */
export interface TursoSyncWorkerStarted {
  id: string;
  started: true;
}

export interface TursoSyncWorkerOkResponse {
  id: string;
  ok: true;
  result: TursoSyncWorkerResult;
}

export interface TursoSyncWorkerErrorResponse {
  id: string;
  ok: false;
  error: string;
}

export type TursoSyncWorkerResponse =
  | TursoSyncWorkerOkResponse
  | TursoSyncWorkerErrorResponse;

/** First line the worker emits once it can accept requests. */
export interface TursoSyncWorkerReady {
  ready: true;
}

export type TursoSyncWorkerLine =
  | TursoSyncWorkerReady
  | TursoSyncWorkerStarted
  | TursoSyncWorkerResponse;

export function isSyncWorkerRequest(value: unknown): value is TursoSyncWorkerRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.localPath === "string" &&
    typeof c.tursoUrl === "string" &&
    typeof c.authToken === "string" &&
    typeof c.op === "string" &&
    (IDEMPOTENT_WORKER_OPS.has(c.op as TursoSyncWorkerOp) ||
      c.op === "write" ||
      c.op === "exec")
  );
}

/**
 * The worker process died while this request was pending.
 *
 * `engineWasRunning` is true when the worker had already reported `started` for this
 * request — i.e. the engine was operating on this replica when the process died. That is
 * the signal to reset the replica's sync sidecars before anything opens it again.
 */
export class TursoSyncWorkerCrashError extends Error {
  readonly op: TursoSyncWorkerOp;
  readonly localPath: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly engineWasRunning: boolean;
  readonly stderrTail: string;

  constructor(options: {
    op: TursoSyncWorkerOp;
    localPath: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    engineWasRunning: boolean;
    stderr?: string;
  }) {
    const how =
      options.signal !== null
        ? `signal ${options.signal}`
        : `exit code ${options.exitCode}`;
    const tail = options.stderr?.trim().slice(-400) ?? "";
    super(
      `Turso sync worker crashed during ${options.op} on ${options.localPath} (${how})` +
        (tail ? `: ${tail}` : ""),
    );
    this.name = "TursoSyncWorkerCrashError";
    this.op = options.op;
    this.localPath = options.localPath;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.engineWasRunning = options.engineWasRunning;
    this.stderrTail = tail;
  }
}

export function isTursoSyncWorkerCrash(
  error: unknown,
): error is TursoSyncWorkerCrashError {
  if (error instanceof TursoSyncWorkerCrashError) {
    return true;
  }
  // instanceof breaks when this module is loaded twice (bundle duplication, test module
  // resets). Getting this wrong silently downgrades a crash to an ordinary error and skips
  // recovery, so fall back to the name the constructor brands.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TursoSyncWorkerCrashError"
  );
}
