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
    const result = await core.run(request);
    emit({ id: request.id, ok: true, result });
  } catch (error) {
    emit({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function shutdown(): Promise<void> {
  await core.closeAll();
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
