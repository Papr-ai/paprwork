/**
 * Publish worker — child process that runs the writer-ops upload for an app:
 * outbox replay, changed-file collection + hashing, the POST to the cloud
 * writer (which can take minutes), and the bookkeeping writes.
 *
 * Nothing here can stall the gateway's event loop. Shared bookkeeping files
 * are guarded by withCrossProcessFileLock. Commit fan-out and "synced" marks
 * are returned to the gateway, which owns those subscribers and that state.
 *
 * stdout carries protocol JSON only; logs go to stderr.
 */

import * as readline from "node:readline";
import * as path from "node:path";
import {
  isPublishWorkerRequest,
  type PublishWorkerError,
  type PublishWorkerLine,
  type PublishWorkerPushRequest,
} from "./publishWorkerProtocol.js";

function emit(line: PublishWorkerLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// Route library console output to stderr so stdout stays protocol-only.
console.log = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);
console.info = console.log;
console.warn = console.log;
console.error = console.log;

function serializeError(err: unknown): PublishWorkerError {
  const e = err as Error & {
    status?: number;
    appId?: string;
    artifacts?: unknown;
  };
  if (e?.name === "AppOpsConflictError" && Array.isArray(e.artifacts)) {
    return {
      name: "AppOpsConflictError",
      message: e.message,
      appId: e.appId ?? "",
      artifacts: e.artifacts as never,
    };
  }
  if (e?.name === "AppOpsClientError" && typeof e.status === "number") {
    return { name: "AppOpsClientError", message: e.message, status: e.status };
  }
  return { name: e?.name ?? "Error", message: e?.message ?? String(err) };
}

async function servePush(request: PublishWorkerPushRequest): Promise<void> {
  const startedAt = Date.now();
  try {
    const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
    const root = path.resolve(getPaprRoot());
    if (root !== path.resolve(request.paprDir)) {
      throw new Error(
        `Workspace changed (worker sees ${root}, gateway sent ${request.paprDir})`,
      );
    }
    // No IPC channel to Electron main here — seed the key the gateway resolved.
    const { seedPaprApiKeyFromParent } = await import("../../utils/keyResolver.js");
    if (!seedPaprApiKeyFromParent(request.apiKey)) {
      throw new Error("Papr API key from the gateway does not match the active workspace");
    }

    const { pushAppWriterOpsForPaprDir } = await import(
      "../syncV3/pushAppWriterOpsCore.js"
    );
    const syncedPaths: string[] = [];
    const committed: Extract<PublishWorkerLine, { ok: true }>["committed"] = [];
    const result = await pushAppWriterOpsForPaprDir({
      paprDir: request.paprDir,
      appId: request.appId,
      message: request.message,
      author: request.author,
      skipPrepare: true,
      onSynced: (paths) => {
        syncedPaths.push(...paths);
      },
      onProgress: (label, detail) => {
        emit({ id: request.id, progress: { label, detail } });
      },
      fanout: async (event) => {
        committed.push(event);
      },
    });
    const { listOwnAppCommits } = await import("../syncV3/appRepoPendingUpdate.js");
    emit({
      id: request.id,
      ok: true,
      result,
      syncedPaths,
      committed,
      ownCommits: listOwnAppCommits(request.appId),
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    emit({
      id: request.id,
      ok: false,
      error: serializeError(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stderr.write("[PublishWorker] ignoring malformed request\n");
      return;
    }
    if (!isPublishWorkerRequest(parsed)) {
      process.stderr.write("[PublishWorker] ignoring unrecognized request\n");
      return;
    }
    void servePush(parsed);
  });
  // Gateway gone (stdin closed) → exit; never outlive the parent.
  rl.on("close", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  emit({ ready: true, pid: process.pid });
}

main();
