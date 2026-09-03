/**
 * Child-process host for @tursodatabase/sync pull/push.
 *
 * Runs one request at a time, opening the replica and closing it again before replying, so
 * exactly one process ever holds a sync engine for a given path. If the engine panics, only
 * this process dies — the parent sees a crash exit and can repair and retry.
 *
 * stdout carries protocol JSON and nothing else; diagnostics go to stderr.
 */

import * as readline from "node:readline";
import { connectTursoReplica } from "./tursoReplicaConnect.js";
import type {
  TursoSyncWorkerRequest,
  TursoSyncWorkerResponse,
} from "./tursoReplicaSyncWorkerProtocol.js";

function reply(response: TursoSyncWorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function isSyncWorkerRequest(value: unknown): value is TursoSyncWorkerRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.localPath === "string" &&
    typeof candidate.tursoUrl === "string" &&
    typeof candidate.authToken === "string" &&
    (candidate.op === "pull" ||
      candidate.op === "push" ||
      candidate.op === "pullPush")
  );
}

async function handleRequest(
  request: TursoSyncWorkerRequest,
): Promise<TursoSyncWorkerResponse> {
  let db: Awaited<ReturnType<typeof connectTursoReplica>> | null = null;
  try {
    db = await connectTursoReplica({
      localPath: request.localPath,
      tursoUrl: request.tursoUrl,
      authToken: request.authToken,
      bootstrapIfEmpty: request.bootstrapIfEmpty,
      clientName: request.clientName,
    });

    let pulled = false;
    if (request.op === "pull" || request.op === "pullPush") {
      pulled = Boolean(await db.pull());
    }
    if (request.op === "push" || request.op === "pullPush") {
      await db.push();
    }

    return { id: request.id, ok: true, pulled };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Release the files before replying — the parent reopens as soon as it sees the response.
    try {
      await db?.close();
    } catch (closeError) {
      process.stderr.write(
        `[TursoSyncWorker] close failed: ${String(closeError)}\n`,
      );
    }
  }
}

/**
 * Runs tasks one at a time in arrival order.
 *
 * Overlapping engines on a single replica is the thing we must never do, and the parent
 * cannot see this queue, so ordering is enforced here.
 */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error: unknown) => {
      // Never let a task rejection become an unhandled rejection that kills the worker.
      process.stderr.write(`[TursoSyncWorker] task failed: ${String(error)}\n`);
    });
  }
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin });
  const queue = new SerialQueue();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stderr.write("[TursoSyncWorker] ignoring malformed request\n");
      return;
    }

    if (!isSyncWorkerRequest(parsed)) {
      process.stderr.write("[TursoSyncWorker] ignoring unrecognized request\n");
      return;
    }

    const request = parsed;
    queue.push(async () => {
      reply(await handleRequest(request));
    });
  });

  rl.on("close", () => {
    process.exit(0);
  });

  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
}

main();
