/**
 * Per-app Sync V3 status for Web sync UI (writer ops + workspace log — not namespace git).
 */

import type { SyncStateManager } from "../cloudSync/syncState.js";
import { shouldAutoUploadApp } from "../cloudUploadMode.js";
import { listOutboxEntries } from "./SyncOutbox.js";
import { listRecentWriterConflicts } from "./writerConflict.js";
import {
  formatFlushQueueDetail,
  formatFlushQueueLabel,
} from "../cloudSync/flushQueueCopy.js";

export type AppSyncV3ItemStatus =
  | "synced"
  | "pending"
  | "uploading"
  | "failed"
  | "conflict"
  | "not_uploaded";

export type AppSyncV3Phase =
  | "synced"
  | "uploading"
  | "not_uploaded"
  | "changed";

export interface AppSyncV3Report {
  protocol: "v3";
  appId: string;
  relativePath: string;
  status: AppSyncV3ItemStatus;
  phase: AppSyncV3Phase;
  label: string;
  detail: string;
  lastUploadedAt: string | null;
  lastError?: string | null;
  manualUploadHold?: boolean;
  pendingWriterOps: number;
  inflightWriterOps: number;
  deadLetterWriterOps: number;
  hasLocalChanges: boolean;
  queuedForUpload: boolean;
}

export interface BuildAppSyncV3ReportOptions {
  appId: string;
  paprDir: string;
  stateManager: SyncStateManager;
  queuedPaths?: readonly string[];
  coordinatorUploading?: boolean;
  coordinatorWaiting?: boolean;
  coordinatorQueued?: boolean;
  queuePosition?: number;
  queueDepth?: number;
  flushErrorMessage?: string | null;
  flushErrorKind?: "conflict" | "error";
}

function buildLabels(input: {
  status: AppSyncV3ItemStatus;
  phase: AppSyncV3Phase;
  manualUploadHold: boolean;
  pendingWriterOps: number;
  lastError?: string | null;
  flushErrorMessage?: string | null;
  flushErrorKind?: "conflict" | "error";
  queuedOnly?: boolean;
  queuePosition?: number;
  queueDepth?: number;
}): { label: string; detail: string } {
  const {
    status,
    phase,
    manualUploadHold,
    pendingWriterOps,
    lastError,
    flushErrorMessage,
    flushErrorKind,
  } = input;

  if (status === "conflict" || flushErrorKind === "conflict") {
    return {
      label: "Conflict on the web",
      detail:
        flushErrorMessage?.slice(0, 160) ??
        lastError?.slice(0, 160) ??
        "Cloud repo changed — get updates or ask the agent, edit locally, then upload again",
    };
  }

  if (status === "failed") {
    return {
      label: "Upload failed",
      detail:
        lastError?.slice(0, 160) ??
        flushErrorMessage?.slice(0, 160) ??
        "Upload failed — retry with Upload now",
    };
  }

  if (phase === "uploading") {
    return {
      label: "Uploading app code…",
      detail:
        pendingWriterOps > 0
          ? `Sending ${pendingWriterOps} change(s) to cloud repo…`
          : "Pushing app files and linked data to the web…",
    };
  }

  if (input.queuedOnly) {
    const position = input.queuePosition;
    const depth = input.queueDepth;
    const label =
      position != null && depth != null && depth > 0
        ? formatFlushQueueLabel(position, depth)
        : "In upload queue";
    const detail =
      position != null && depth != null && depth > 0
        ? formatFlushQueueDetail(position, depth)
        : "Waiting for other apps to finish uploading…";
    return { label, detail };
  }

  if (manualUploadHold && phase === "changed") {
    return {
      label: "Local changes waiting",
      detail: "Manual upload mode — click Upload now",
    };
  }

  switch (phase) {
    case "synced":
      return {
        label: "App code on the web",
        detail: "App files match the cloud repo",
      };
    case "not_uploaded":
      return {
        label: "Not uploaded yet",
        detail: "App code has not been pushed to the cloud repo",
      };
    case "changed":
      return {
        label: "Local changes not on web",
        detail:
          pendingWriterOps > 0
            ? `${pendingWriterOps} writer change(s) waiting to upload`
            : "Local app files differ from the last cloud upload",
      };
    default:
      return {
        label: "Sync status unknown",
        detail: "Could not determine app sync state",
      };
  }
}

export async function buildAppSyncV3Report(
  options: BuildAppSyncV3ReportOptions,
): Promise<AppSyncV3Report> {
  const { appId, paprDir, stateManager } = options;
  const relativePath = `apps/${appId}`;
  const queuedPaths = new Set(options.queuedPaths ?? []);
  const syncedRecord = stateManager.data.syncedItems[relativePath];
  const hasLocalChanges = stateManager.hasItemChanged(relativePath);
  const autoUpload = shouldAutoUploadApp(appId, paprDir);
  const manualUploadHold = !autoUpload && hasLocalChanges;

  // One read, three views. Reading the queue three times per app meant the
  // whole file was parsed once per report — and the reports run on launch.
  const outboxEntries = await listOutboxEntries(appId);
  const pendingOutbox = outboxEntries.filter((e) => e.status === "pending");
  const deadLetterOutbox = outboxEntries.filter(
    (e) => e.status === "dead_letter",
  );
  const pendingWriterOps = pendingOutbox.length;
  const inflightWriterOps = outboxEntries.filter(
    (e) => e.status === "inflight",
  ).length;
  const deadLetterWriterOps = outboxEntries.filter(
    (e) => e.status === "dead_letter" || e.status === "failed",
  ).length;

  const conflicts = listRecentWriterConflicts(appId);
  const folderDeadLetter = stateManager.data.deadLetter?.[relativePath];

  const outboxLastError =
    deadLetterOutbox[deadLetterOutbox.length - 1]?.lastError ??
    outboxEntries.find((e) => e.lastError)?.lastError ??
    null;

  const lastError =
    folderDeadLetter?.lastError ??
    outboxLastError ??
    options.flushErrorMessage ??
    null;

  const queuedForUpload = queuedPaths.has(relativePath);
  const alreadySyncedOnWeb =
    Boolean(syncedRecord?.lastSyncAt) &&
    !hasLocalChanges &&
    pendingWriterOps === 0 &&
    inflightWriterOps === 0 &&
    pendingOutbox.length === 0 &&
    !folderDeadLetter;

  let status: AppSyncV3ItemStatus = "synced";
  if (conflicts.length > 0 || options.flushErrorKind === "conflict") {
    status = "conflict";
  } else if (
    folderDeadLetter ||
    deadLetterWriterOps > 0 ||
    options.flushErrorMessage
  ) {
    status = "failed";
  } else if (options.coordinatorUploading || inflightWriterOps > 0) {
    status = "uploading";
  } else if (
    !alreadySyncedOnWeb &&
    (hasLocalChanges ||
      pendingWriterOps > 0 ||
      pendingOutbox.length > 0 ||
      queuedForUpload ||
      options.coordinatorQueued)
  ) {
    status = "pending";
  } else if (!syncedRecord?.lastSyncAt) {
    status = "not_uploaded";
  }

  let phase: AppSyncV3Phase = "synced";
  if (status === "uploading") {
    phase = "uploading";
  } else if (status === "not_uploaded") {
    phase = "not_uploaded";
  } else if (
    status === "pending" ||
    status === "failed" ||
    status === "conflict"
  ) {
    phase = "changed";
  }

  const queuedOnly =
    !alreadySyncedOnWeb &&
    (queuedForUpload || options.coordinatorQueued === true) &&
    status !== "uploading";

  const { label, detail } = buildLabels({
    status,
    phase,
    manualUploadHold,
    pendingWriterOps: pendingWriterOps + inflightWriterOps,
    lastError,
    flushErrorMessage: options.flushErrorMessage,
    flushErrorKind: options.flushErrorKind,
    queuedOnly,
    queuePosition: options.queuePosition,
    queueDepth: options.queueDepth,
  });

  return {
    protocol: "v3",
    appId,
    relativePath,
    status,
    phase,
    label,
    detail,
    lastUploadedAt: syncedRecord?.lastSyncAt ?? null,
    lastError,
    manualUploadHold,
    pendingWriterOps,
    inflightWriterOps,
    deadLetterWriterOps,
    hasLocalChanges,
    queuedForUpload,
  };
}
