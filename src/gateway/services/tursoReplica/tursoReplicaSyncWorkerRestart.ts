import type { TursoSyncWorkerOp } from "./tursoReplicaSyncWorkerProtocol.js";

/**
 * A request that was still in flight when the client itself killed the shared sync worker
 * because a *different* request timed out. The engine did not abort, so this is
 * deliberately not a {@link TursoSyncWorkerCrashError}: it must not reset sidecars, count
 * toward a crash streak, or reach crash telemetry. Idempotent ops are retried once.
 */
export class TursoSyncWorkerRestartedError extends Error {
  readonly op: TursoSyncWorkerOp;
  readonly localPath: string;
  readonly timedOut: { op: TursoSyncWorkerOp; localPath: string };

  constructor(options: {
    op: TursoSyncWorkerOp;
    localPath: string;
    cause: { op: TursoSyncWorkerOp; localPath: string };
  }) {
    super(
      `Turso sync worker was restarted during ${options.op} on ${options.localPath} ` +
        `because ${options.cause.op} on ${options.cause.localPath} timed out; ` +
        "this database was not at fault",
    );
    this.name = "TursoSyncWorkerRestartedError";
    this.op = options.op;
    this.localPath = options.localPath;
    this.timedOut = options.cause;
  }
}

export function isTursoSyncWorkerRestarted(
  error: unknown,
): error is TursoSyncWorkerRestartedError {
  // Same reasoning as isTursoSyncWorkerCrash: instanceof breaks across duplicated modules.
  return (
    error instanceof TursoSyncWorkerRestartedError ||
    (error instanceof Error && error.name === "TursoSyncWorkerRestartedError")
  );
}
