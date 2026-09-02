/**
 * Wire protocol between the gateway and the out-of-process Turso sync worker.
 *
 * Newline-delimited JSON over stdin/stdout. Kept in its own module so the parent
 * and the child agree on the shape without the parent importing anything that
 * pulls in the native sync engine.
 */

export type TursoSyncWorkerOp = "pull" | "push" | "pullPush";

export interface TursoSyncWorkerRequest {
  id: string;
  op: TursoSyncWorkerOp;
  localPath: string;
  tursoUrl: string;
  authToken: string;
  clientName?: string;
  /** Passed through to connect(); false keeps an existing local file authoritative. */
  bootstrapIfEmpty: boolean;
}

export interface TursoSyncWorkerOkResponse {
  id: string;
  ok: true;
  /** Result of pull(); false for push-only operations. */
  pulled: boolean;
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

/**
 * The worker process died mid-request.
 *
 * This is the case the worker exists for: a Rust `panic!` in the sync engine aborts
 * whatever process hosts it. Out-of-process that is a recoverable child crash; in-process
 * it was the gateway going down with the app.
 */
export class TursoSyncWorkerCrashError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(options: {
    op: TursoSyncWorkerOp;
    localPath: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr?: string;
  }) {
    const how =
      options.signal !== null
        ? `signal ${options.signal}`
        : `exit code ${options.exitCode}`;
    const tail = options.stderr?.trim().slice(-400);
    super(
      `Turso sync worker crashed during ${options.op} on ${options.localPath} (${how})` +
        (tail ? `: ${tail}` : ""),
    );
    this.name = "TursoSyncWorkerCrashError";
    this.exitCode = options.exitCode;
    this.signal = options.signal;
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
