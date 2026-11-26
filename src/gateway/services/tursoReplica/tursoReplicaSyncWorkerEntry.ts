/**
 * Child-process host for @tursodatabase/sync.
 *
 * This is the only process that loads the native sync engine. It keeps one Database handle
 * open per replica path and serves query/write/exec/pull/push requests against it. If the
 * engine panics, only this process dies — the gateway sees a crash exit and can repair
 * sidecars, respawn, and retry.
 *
 * stdout carries protocol JSON and nothing else; diagnostics go to stderr.
 */

import * as readline from "node:readline";
import { TursoSyncWorkerCore } from "./tursoReplicaSyncWorkerCore.js";
import {
  isSyncWorkerRequest,
  type TursoSyncWorkerLine,
  type TursoSyncWorkerRequest,
} from "./tursoReplicaSyncWorkerProtocol.js";
import { captureServiceSecrets } from "../../../core/utils/serviceSecrets.js";
// Worker is Papr code: keep its copy, but nothing it spawns inherits it.
captureServiceSecrets();

function emit(line: TursoSyncWorkerLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function log(message: string): void {
  process.stderr.write(`[TursoSyncWorker] ${message}\n`);
}

const core = new TursoSyncWorkerCore(log);

async function serve(request: TursoSyncWorkerRequest): Promise<void> {
  emit({ id: request.id, started: true });
  try {
    const { result, opTiming } = await core.run(request);
    emit({ id: request.id, ok: true, result, opTiming });
  } catch (error) {
    emit({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * How long a clean close may take before the worker exits anyway. The native
 * `SyncEngine.close` can block the main thread forever (seen in the field: a worker parked
 * in `close_c_callback` → semaphore wait for hours). A worker that never exits keeps its
 * POSIX locks on every replica it had open, so the gateway's next worker fails every write
 * with "File is locked by another process" until the app is restarted. Committed data is
 * in the WAL already; exiting without the close loses nothing.
 */
const SHUTDOWN_DEADLINE_MS = 3_000;
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Armed before closeAll: if close blocks the event loop natively this timer cannot fire,
  // which is why the gateway also escalates to SIGKILL (see retireChild in the client).
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
  try {
    await core.closeAll();
  } catch (error) {
    log(`closeAll failed during shutdown: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      log("ignoring malformed request");
      return;
    }
    if (!isSyncWorkerRequest(parsed)) {
      log("ignoring unrecognized request");
      return;
    }
    void serve(parsed);
  });

  rl.on("close", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  emit({ ready: true });
}

main();
