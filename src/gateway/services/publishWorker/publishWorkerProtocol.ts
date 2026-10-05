/**
 * Line-delimited JSON protocol between the gateway and the publish worker.
 *
 * stdin  (gateway → worker): PublishWorkerRequest, one per line
 * stdout (worker → gateway): PublishWorkerLine, one per line — nothing else
 * stderr: worker logs, forwarded to the gateway console with a prefix
 */

import type { AppRepoOpsConflictResponse } from "../../../core/types/appRepoWriterOps.js";
import type { AppRepoCommittedEvent } from "../syncV3/appRepoCommittedFanout.js";
import type { PushAppViaWriterResult } from "../syncV3/pushAppViaWriterOps.js";

export interface PublishWorkerPushRequest {
  id: string;
  kind: "push-writer-ops";
  appId: string;
  /** Gateway's workspace root; the worker refuses to run against a different one. */
  paprDir: string;
  /** Resolved by the gateway (main-process keychain) — the worker has no IPC to main. */
  apiKey: string;
  message?: string;
  author?: string;
}

export type PublishWorkerRequest = PublishWorkerPushRequest;

export type PublishWorkerError =
  | {
      name: "AppOpsConflictError";
      message: string;
      appId: string;
      artifacts: AppRepoOpsConflictResponse["artifacts"];
    }
  | { name: "AppOpsClientError"; message: string; status: number }
  | { name: string; message: string };

export type PublishWorkerLine =
  | { ready: true; pid: number }
  | { id: string; progress: { label: string; detail?: string } }
  | {
      id: string;
      ok: true;
      result: PushAppViaWriterResult;
      /** Workspace-relative paths the gateway marks synced. */
      syncedPaths: string[];
      /** Commit events the gateway fans out (subscribers live in the gateway). */
      committed: AppRepoCommittedEvent[];
      /**
       * Commits this upload made (incl. outbox replays). The gateway records
       * them as its own so the commit notification is not pulled as a remote update.
       */
      ownCommits: string[];
      durationMs: number;
    }
  | { id: string; ok: false; error: PublishWorkerError; durationMs: number };

export function isPublishWorkerRequest(value: unknown): value is PublishWorkerRequest {
  const v = value as Partial<PublishWorkerPushRequest> | null;
  return (
    !!v &&
    typeof v.id === "string" &&
    v.kind === "push-writer-ops" &&
    typeof v.appId === "string" &&
    typeof v.paprDir === "string" &&
    typeof v.apiKey === "string"
  );
}
